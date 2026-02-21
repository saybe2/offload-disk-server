#!/usr/bin/env python3
import os
import queue
import threading
import time
from datetime import datetime
import tkinter as tk
from tkinter import ttk, messagebox

try:
    from pymongo import MongoClient
except Exception:
    MongoClient = None


def format_int(value: int) -> str:
    return f"{max(0, int(value)):,}".replace(",", " ")


def format_duration(seconds: float) -> str:
    sec = max(0, int(seconds))
    days = sec // 86400
    hours = (sec % 86400) // 3600
    minutes = (sec % 3600) // 60
    if days > 0:
        return f"{days}d {hours}h {minutes}m"
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def fetch_stats(uri: str, db_name: str) -> dict:
    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    try:
        coll = client[db_name]["archives"]
        base_active = {"deletedAt": None, "trashedAt": None}
        ready = {**base_active, "status": "ready"}

        v1_filter = {
            **ready,
            "$or": [
                {"encryptionVersion": {"$exists": False}},
                {"encryptionVersion": {"$lt": 2}},
            ],
        }
        v2_filter = {**ready, "encryptionVersion": {"$gte": 2}}

        v1_ready = coll.count_documents(v1_filter)
        v2_ready = coll.count_documents(v2_filter)
        queued = coll.count_documents({**base_active, "status": "queued"})
        processing = coll.count_documents({**base_active, "status": "processing"})
        errors = coll.count_documents({**base_active, "status": "error"})

        total = v1_ready + v2_ready
        progress = 100.0 if total == 0 else (v2_ready / total) * 100.0

        return {
            "ts": time.time(),
            "v1_ready": v1_ready,
            "v2_ready": v2_ready,
            "queued": queued,
            "processing": processing,
            "errors": errors,
            "progress": progress,
        }
    finally:
        client.close()


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("V1 -> V2 Migration Monitor")
        self.root.geometry("700x420")
        self.root.minsize(660, 380)

        self.uri_var = tk.StringVar(value=os.getenv("MONGODB_URI", ""))
        self.db_var = tk.StringVar(value=os.getenv("MONGODB_DB", "cloud_storage"))
        self.interval_var = tk.StringVar(value="10")
        self.status_var = tk.StringVar(value="Stopped")

        self.v1_var = tk.StringVar(value="-")
        self.v2_var = tk.StringVar(value="-")
        self.progress_var = tk.StringVar(value="-")
        self.queued_var = tk.StringVar(value="-")
        self.processing_var = tk.StringVar(value="-")
        self.errors_var = tk.StringVar(value="-")
        self.rate_var = tk.StringVar(value="-")
        self.eta_var = tk.StringVar(value="-")
        self.updated_var = tk.StringVar(value="-")

        self.progress_value = tk.DoubleVar(value=0.0)

        self.running = False
        self.worker = None
        self.stop_event = threading.Event()
        self.event_queue = queue.Queue()
        self.history = []

        self._build_ui()
        self._pump_queue()

    def _build_ui(self):
        top = ttk.Frame(self.root, padding=10)
        top.pack(fill="x")

        ttk.Label(top, text="Mongo URI:").grid(row=0, column=0, sticky="w")
        uri_entry = ttk.Entry(top, textvariable=self.uri_var)
        uri_entry.grid(row=0, column=1, sticky="ew", padx=(8, 6))

        ttk.Label(top, text="DB:").grid(row=0, column=2, sticky="w")
        db_entry = ttk.Entry(top, textvariable=self.db_var, width=16)
        db_entry.grid(row=0, column=3, sticky="w", padx=(8, 6))

        ttk.Label(top, text="Interval (s):").grid(row=0, column=4, sticky="w")
        iv_entry = ttk.Entry(top, textvariable=self.interval_var, width=8)
        iv_entry.grid(row=0, column=5, sticky="w", padx=(8, 0))

        top.columnconfigure(1, weight=1)

        controls = ttk.Frame(self.root, padding=(10, 0, 10, 0))
        controls.pack(fill="x")
        self.start_btn = ttk.Button(controls, text="Start", command=self.start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(controls, text="Stop", command=self.stop, state="disabled")
        self.stop_btn.pack(side="left", padx=(8, 0))
        ttk.Label(controls, textvariable=self.status_var).pack(side="right")

        progress_wrap = ttk.Frame(self.root, padding=10)
        progress_wrap.pack(fill="x")
        ttk.Label(progress_wrap, text="Progress:").pack(anchor="w")
        self.progressbar = ttk.Progressbar(
            progress_wrap, mode="determinate", maximum=100.0, variable=self.progress_value
        )
        self.progressbar.pack(fill="x", pady=(4, 0))

        grid = ttk.Frame(self.root, padding=10)
        grid.pack(fill="both", expand=True)

        labels = [
            ("V1 remaining", self.v1_var),
            ("V2 done", self.v2_var),
            ("Progress %", self.progress_var),
            ("Queued", self.queued_var),
            ("Processing", self.processing_var),
            ("Errors", self.errors_var),
            ("Rate", self.rate_var),
            ("ETA", self.eta_var),
            ("Last update", self.updated_var),
        ]

        for i, (name, var) in enumerate(labels):
            r = i // 3
            c = (i % 3) * 2
            ttk.Label(grid, text=name + ":").grid(row=r, column=c, sticky="w", padx=(0, 8), pady=4)
            ttk.Label(grid, textvariable=var).grid(row=r, column=c + 1, sticky="w", padx=(0, 18), pady=4)

        for c in range(6):
            grid.columnconfigure(c, weight=1 if c % 2 == 1 else 0)

    def start(self):
        if MongoClient is None:
            messagebox.showerror("Missing dependency", "Install pymongo:\n\npip install pymongo")
            return
        if self.running:
            return

        uri = self.uri_var.get().strip()
        db_name = self.db_var.get().strip()
        if not uri:
            messagebox.showerror("Config error", "Mongo URI is required.")
            return
        if not db_name:
            messagebox.showerror("Config error", "DB name is required.")
            return

        try:
            interval = int(self.interval_var.get().strip())
            if interval <= 0:
                raise ValueError
        except Exception:
            messagebox.showerror("Config error", "Interval must be a positive integer.")
            return

        self.stop_event.clear()
        self.running = True
        self.status_var.set("Running")
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.history.clear()

        self.worker = threading.Thread(
            target=self._worker_loop, args=(uri, db_name, interval), daemon=True
        )
        self.worker.start()

    def stop(self):
        if not self.running:
            return
        self.stop_event.set()
        self.running = False
        self.status_var.set("Stopped")
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")

    def _worker_loop(self, uri: str, db_name: str, interval: int):
        while not self.stop_event.is_set():
            try:
                stats = fetch_stats(uri, db_name)
                self.event_queue.put(("stats", stats))
            except Exception as exc:
                self.event_queue.put(("error", str(exc)))
            for _ in range(interval * 10):
                if self.stop_event.is_set():
                    break
                time.sleep(0.1)

    def _pump_queue(self):
        while True:
            try:
                kind, payload = self.event_queue.get_nowait()
            except queue.Empty:
                break

            if kind == "error":
                self.status_var.set(f"Error: {payload}")
            else:
                self._apply_stats(payload)

        self.root.after(250, self._pump_queue)

    def _apply_stats(self, stats: dict):
        self.history.append({"ts": stats["ts"], "v1": stats["v1_ready"]})
        cutoff = time.time() - 6 * 3600
        self.history = [x for x in self.history if x["ts"] >= cutoff]

        rate_per_hour = 0.0
        if len(self.history) >= 2:
            oldest = self.history[0]
            newest = self.history[-1]
            dv1 = oldest["v1"] - newest["v1"]
            dt = newest["ts"] - oldest["ts"]
            if dv1 > 0 and dt > 0:
                rate_per_hour = (dv1 * 3600.0) / dt

        eta_text = "n/a"
        if rate_per_hour > 0:
            eta_seconds = (stats["v1_ready"] / rate_per_hour) * 3600.0
            eta_text = format_duration(eta_seconds)

        self.v1_var.set(format_int(stats["v1_ready"]))
        self.v2_var.set(format_int(stats["v2_ready"]))
        self.progress_var.set(f"{stats['progress']:.2f}%")
        self.queued_var.set(format_int(stats["queued"]))
        self.processing_var.set(format_int(stats["processing"]))
        self.errors_var.set(format_int(stats["errors"]))
        self.rate_var.set(f"{rate_per_hour:.2f} v1/hour" if rate_per_hour > 0 else "n/a")
        self.eta_var.set(eta_text)
        self.updated_var.set(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        self.progress_value.set(max(0.0, min(100.0, float(stats["progress"]))))
        self.status_var.set("Running")


def main():
    root = tk.Tk()
    style = ttk.Style(root)
    if "vista" in style.theme_names():
        style.theme_use("vista")
    app = App(root)
    root.protocol("WM_DELETE_WINDOW", lambda: (app.stop(), root.destroy()))
    root.mainloop()


if __name__ == "__main__":
    main()

