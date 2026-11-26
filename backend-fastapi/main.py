from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, List
import jwt
import os
from datetime import datetime
import httpx
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="LiveQuiz+ FastAPI Service", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security
security = HTTPBearer()
JWT_SECRET = os.getenv("JWT_SECRET", "livequiz-secret-2025")
NODE_API_URL = os.getenv("NODE_API_URL", "http://localhost:3000")

# Models
class TaskRequest(BaseModel):
    type: str
    data: dict

class AnalyticsRequest(BaseModel):
    event_type: str
    user_id: Optional[str] = None
    quiz_id: Optional[str] = None
    metadata: Optional[dict] = None

class PerformanceMetrics(BaseModel):
    response_time: float
    endpoint: str
    status_code: int
    timestamp: datetime

# Authentication dependency
async def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        token = credentials.credentials
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

# ==================== CELERY TASK ENDPOINTS ====================

@app.post("/api/tasks")
async def create_task(task: TaskRequest):
    """
    Create a background task (simulates Celery task creation)
    In production, this would enqueue tasks to Celery
    """
    try:
        logger.info(f"Task created: {task.type}", extra={"task_data": task.data})
        
        # In production, this would use Celery:
        # from celery_app import process_task
        # process_task.delay(task.type, task.data)
        
        # For now, we'll call the Node.js API to process the task
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{NODE_API_URL}/api/internal/process-task",
                json={"type": task.type, "data": task.data},
                timeout=30.0
            )
        
        return {"success": True, "task_id": f"task_{datetime.now().timestamp()}"}
    except Exception as e:
        logger.error(f"Task creation failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tasks/{task_id}/status")
async def get_task_status(task_id: str):
    """Get status of a background task"""
    # In production, this would query Celery task status
    return {"task_id": task_id, "status": "completed", "progress": 100}

# ==================== ANALYTICS ENDPOINTS ====================

@app.post("/api/analytics/event")
async def log_event(event: AnalyticsRequest):
    """Log an analytics event"""
    try:
        logger.info(
            f"Analytics event: {event.event_type}",
            extra={
                "user_id": event.user_id,
                "quiz_id": event.quiz_id,
                "metadata": event.metadata
            }
        )
        
        # In production, send to analytics service or database
        return {"success": True}
    except Exception as e:
        logger.error(f"Analytics logging failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/analytics/events")
async def get_events(
    event_type: Optional[str] = None,
    user_id: Optional[str] = None,
    limit: int = 100,
    user: dict = Depends(verify_token)
):
    """Get analytics events (requires authentication)"""
    # In production, query from analytics database
    return {
        "events": [],
        "total": 0,
        "filters": {"event_type": event_type, "user_id": user_id}
    }

# ==================== PERFORMANCE MONITORING ====================

@app.post("/api/metrics/performance")
async def record_performance(metrics: PerformanceMetrics):
    """Record performance metrics"""
    try:
        logger.info(
            f"Performance metric: {metrics.endpoint}",
            extra={
                "response_time": metrics.response_time,
                "status_code": metrics.status_code,
                "timestamp": metrics.timestamp.isoformat()
            }
        )
        return {"success": True}
    except Exception as e:
        logger.error(f"Performance recording failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/metrics/summary")
async def get_performance_summary(user: dict = Depends(verify_token)):
    """Get performance metrics summary"""
    # In production, aggregate from metrics database
    return {
        "avg_response_time": 0.15,
        "total_requests": 0,
        "error_rate": 0.0,
        "uptime": "99.9%"
    }

# ==================== HEALTH CHECK ====================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "livequiz-fastapi",
        "timestamp": datetime.now().isoformat()
    }

@app.get("/")
async def root():
    return {
        "message": "LiveQuiz+ FastAPI Service",
        "version": "1.0.0",
        "endpoints": {
            "tasks": "/api/tasks",
            "analytics": "/api/analytics/event",
            "metrics": "/api/metrics/performance",
            "health": "/health"
        }
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

