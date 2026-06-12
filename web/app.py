"""last30days web UI — Flask backend."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
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

# Active jobs: job_id -> {"queue": Queue, "status": str, "result_path": str|None}
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


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
            slug = topic.lower()
            import re
            slug = re.sub(r"[^a-z0-9]+", "-", slug).strip("-") or "last30days"
            result_path = SAVE_DIR / f"{slug}-raw.md"
            html_path = SAVE_DIR / f"{slug}-brief.html"

            with _jobs_lock:
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["result_path"] = str(html_path) if html_path.exists() else str(result_path)
                _jobs[job_id]["output"] = "".join(stdout_chunks)

            send("done", json.dumps({
                "result_path": str(html_path) if html_path.exists() else str(result_path),
                "has_html": html_path.exists(),
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
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
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
    files = sorted(SAVE_DIR.glob("*-raw.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    html_files = sorted(SAVE_DIR.glob("*-brief.html"), key=lambda f: f.stat().st_mtime, reverse=True)
    history = []
    seen = set()
    for f in html_files:
        slug = f.stem.replace("-brief", "")
        if slug not in seen:
            seen.add(slug)
            topic = slug.replace("-", " ").title()
            history.append({
                "slug": slug,
                "topic": topic,
                "path": str(f),
                "type": "html",
                "modified": f.stat().st_mtime,
            })
    for f in files:
        slug = f.stem.replace("-raw", "")
        if slug not in seen:
            seen.add(slug)
            topic = slug.replace("-", " ").title()
            history.append({
                "slug": slug,
                "topic": topic,
                "path": str(f),
                "type": "md",
                "modified": f.stat().st_mtime,
            })
    return jsonify(history[:20])


@app.route("/api/brief/<path:slug>")
def api_brief(slug: str):
    html_path = SAVE_DIR / f"{slug}-brief.html"
    md_path = SAVE_DIR / f"{slug}-raw.md"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8"), 200, {"Content-Type": "text/html; charset=utf-8"}
    if md_path.exists():
        content = md_path.read_text(encoding="utf-8")
        return jsonify({"content": content, "type": "markdown"})
    return jsonify({"error": "not found"}), 404


if __name__ == "__main__":
    if not LAST30_PY.exists():
        print(f"ERROR: Cannot find research engine at {LAST30_PY}")
        print("Make sure you run this from inside the repo root: python3 web/app.py")
        sys.exit(1)
    print(f"🌐 last30days web UI → http://localhost:7430")
    print(f"   Engine: {LAST30_PY}")
    print(f"   Briefs: {SAVE_DIR}")
    app.run(host="0.0.0.0", port=7430, debug=False, threaded=True)
