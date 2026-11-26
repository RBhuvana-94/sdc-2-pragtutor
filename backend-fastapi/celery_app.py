from celery import Celery
import os
from datetime import timedelta

# Redis broker URL
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# Create Celery app
celery_app = Celery(
    "livequiz_tasks",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks"]
)

# Celery configuration
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=30 * 60,  # 30 minutes
    task_soft_time_limit=25 * 60,  # 25 minutes
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=1000,
)

# Task routing
celery_app.conf.task_routes = {
    "tasks.process_quiz_start": {"queue": "quiz_queue"},
    "tasks.compile_results": {"queue": "results_queue"},
    "tasks.update_leaderboard": {"queue": "leaderboard_queue"},
}

if __name__ == "__main__":
    celery_app.start()

