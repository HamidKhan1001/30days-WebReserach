"""last30days web UI — Flask backend."""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

WEB_DIR = Path(__file__).parent.resolve()
app = Flask(
    __name__,
    template_folder=str(WEB_DIR / "templates"),
    static_folder=str(WEB_DIR / "static"),
    static_url_path="/static",
)
app.secret_key = os.urandom(24)

SCRIPT_DIR = WEB_DIR.parent / "skills" / "last30days" / "scripts"
LAST30_PY = SCRIPT_DIR / "last30days.py"
SAVE_DIR = Path.home() / "Documents" / "Last30Days"
SAVE_DIR.mkdir(parents=True, exist_ok=True)

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _slugify(topic: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-") or "last30days"


def _find_output_file(slug: str) -> Path | None:
    """Find the most recently written file for this slug — any suffix the engine may use."""
    candidates = sorted(
        SAVE_DIR.glob(f"{slug}-raw*"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def _run_research(job_id: str, topic: str, emit: str, extra_flags: list[str]) -> None:
    q: queue.Queue = _jobs[job_id]["queue"]

    def send(event: str, data: str) -> None:
        q.put({"event": event, "data": data})

    send("status", "Starting research engine…")

    cmd = [
        sys.executable,
        str(LAST30_PY),
        topic,
        f"--emit={emit}",
        f"--save-dir={SAVE_DIR}",
        *extra_flags,
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(SCRIPT_DIR),
        )

        stderr_lines: list[str] = []

        def _read_stderr() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                line = line.rstrip()
                if line:
                    stderr_lines.append(line)
                    send("log", line)

        t = threading.Thread(target=_read_stderr, daemon=True)
        t.start()

        stdout_chunks: list[str] = []
        assert proc.stdout is not None
        for chunk in proc.stdout:
            stdout_chunks.append(chunk)
            send("chunk", chunk)

        proc.wait()
        t.join(timeout=5)

        if proc.returncode == 0:
            slug = _slugify(topic)
            result_file = _find_output_file(slug)
            result_path = str(result_file) if result_file else None
            is_html = result_file is not None and result_file.suffix == ".html"

            with _jobs_lock:
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["result_path"] = result_path
                _jobs[job_id]["slug"] = slug
                _jobs[job_id]["output"] = "".join(stdout_chunks)

            send("done", json.dumps({
                "result_path": result_path,
                "slug": slug,
                "has_html": is_html,
                "filename": result_file.name if result_file else None,
            }))
        else:
            err = "\n".join(stderr_lines[-10:])
            with _jobs_lock:
                _jobs[job_id]["status"] = "error"
            send("error", err or f"Process exited with code {proc.returncode}")

    except Exception as exc:
        with _jobs_lock:
            _jobs[job_id]["status"] = "error"
        send("error", str(exc))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/search", methods=["POST"])
def api_search():
    data = request.get_json(force=True)
    topic = (data.get("topic") or "").strip()
    if not topic:
        return jsonify({"error": "topic required"}), 400

    emit = data.get("emit", "html")
    flags = []
    if data.get("competitors"):
        flags.append("--competitors")

    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "queue": queue.Queue(),
            "status": "running",
            "result_path": None,
            "output": None,
        }

    threading.Thread(
        target=_run_research,
        args=(job_id, topic, emit, flags),
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/api/stream/<job_id>")
def api_stream(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404

    def generate():
        q: queue.Queue = job["queue"]
        while True:
            try:
                msg = q.get(timeout=30)
                yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'])}\n\n"
                if msg["event"] in ("done", "error"):
                    break
            except queue.Empty:
                yield "event: ping\ndata: {}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/result/<job_id>")
def api_result(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "status": job["status"],
        "result_path": job.get("result_path"),
        "output": job.get("output"),
    })


@app.route("/api/history")
def api_history():
    # Match all engine output files: *-raw*.html and *-raw.md
    all_files = sorted(
        list(SAVE_DIR.glob("*-raw*.html")) + list(SAVE_DIR.glob("*-raw*.md")),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    history = []
    seen_slugs: set[str] = set()
    for f in all_files:
        # Extract slug: everything before -raw
        m = re.match(r"^(.+?)-raw", f.stem)
        if not m:
            continue
        slug = m.group(1)
        if slug in seen_slugs:
            continue
        seen_slugs.add(slug)
        topic = slug.replace("-", " ").title()
        history.append({
            "slug": slug,
            "topic": topic,
            "filename": f.name,
            "type": "html" if f.suffix == ".html" else "md",
            "modified": f.stat().st_mtime,
        })
        if len(history) >= 20:
            break
    return jsonify(history)


@app.route("/api/brief/<path:slug>")
def api_brief(slug: str):
    # Find the best file for this slug
    f = _find_output_file(slug)
    if f and f.exists():
        if f.suffix == ".html":
            return f.read_text(encoding="utf-8"), 200, {"Content-Type": "text/html; charset=utf-8"}
        else:
            # Wrap markdown in a simple styled page
            content = f.read_text(encoding="utf-8")
            escaped = content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            html = f"""<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body{{background:#0e0e10;color:#e4e4e7;font-family:'Inter',system-ui,sans-serif;
max-width:760px;margin:0 auto;padding:3rem 1.5rem;line-height:1.7;font-size:16px}}
pre{{background:#18181b;border:1px solid #27272a;border-radius:8px;padding:1rem;
overflow-x:auto;font-size:13px;white-space:pre-wrap;word-break:break-word}}
</style></head><body><pre>{escaped}</pre></body></html>"""
            return html, 200, {"Content-Type": "text/html; charset=utf-8"}
    return jsonify({"error": "not found"}), 404


if __name__ == "__main__":
    if not LAST30_PY.exists():
        print(f"ERROR: Cannot find research engine at {LAST30_PY}")
        print("Run from repo root: python3 web/app.py")
        sys.exit(1)
    print("🌐 last30days web UI → http://localhost:7430")
    print(f"   Engine: {LAST30_PY}")
    print(f"   Briefs: {SAVE_DIR}")
    app.run(host="0.0.0.0", port=7430, debug=False, threaded=True)
