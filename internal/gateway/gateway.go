package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/lobs-ai/squad/internal/protocol"
	"github.com/lobs-ai/squad/pkg/models"
)

type Gateway struct {
	sessions    map[string]*models.Session
	sessionLock sync.RWMutex
	upgrader    websocket.Upgrader
	server      *http.Server
}

func New() *Gateway {
	return &Gateway{
		sessions: make(map[string]*models.Session),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // TODO: Check against allowed origins
			},
		},
	}
}

func (g *Gateway) Start() error {
	mux := http.NewServeMux()
	
	// Health check
	mux.HandleFunc("/health", g.handleHealth)
	
	// WebSocket endpoint for connectors
	mux.HandleFunc("/ws", g.handleWebSocket)
	
	// REST API for sessions
	mux.HandleFunc("/api/sessions", g.handleSessionsAPI)
	
	addr := fmt.Sprintf("%s:%d", "0.0.0.0", 8080)
	log.Printf("Starting Squad Gateway on %s", addr)
	
	g.server = &http.Server{
		Addr:    addr,
		Handler: mux,
	}
	
	return g.server.ListenAndServe()
}

func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (g *Gateway) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := g.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()
	
	g.handleConnection(conn)
}

func (g *Gateway) handleConnection(conn *websocket.Conn) {
	for {
		var msg protocol.Message
		if err := conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			return
		}
		
		g.handleMessage(conn, &msg)
	}
}

func (g *Gateway) handleMessage(conn *websocket.Conn, msg *protocol.Message) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	var response protocol.Message
	
	switch msg.Type {
	case "session.start":
		session := &models.Session{
			ID:        uuid.New().String(),
			CreatedAt: time.Now(),
			Metadata:  msg.Payload,
		}
		g.sessionLock.Lock()
		g.sessions[session.ID] = session
		g.sessionLock.Unlock()
		
		response = protocol.Message{
			Type:    "session.started",
			ID:      msg.ID,
			Payload: map[string]interface{}{"session_id": session.ID},
		}
		
	case "session.send":
		sessionID, _ := msg.Payload["session_id"].(string)
		content, _ := msg.Payload["content"].(string)
		
		g.sessionLock.RLock()
		session, exists := g.sessions[sessionID]
		g.sessionLock.RUnlock()
		
		if !exists {
			response = protocol.Error(msg.ID, "session not found")
		} else {
			// TODO: Forward to runtime
			session.Messages = append(session.Messages, models.Message{
				Role:    "user",
				Content: content,
			})
			
			response = protocol.Message{
				Type:    "session.response",
				ID:      msg.ID,
				Payload: map[string]interface{}{"content": "Echo: " + content}, // TODO: Replace with actual runtime response
			}
		}
		
	case "session.end":
		sessionID, _ := msg.Payload["session_id"].(string)
		g.sessionLock.Lock()
		delete(g.sessions, sessionID)
		g.sessionLock.Unlock()
		
		response = protocol.Message{
			Type:    "session.ended",
			ID:      msg.ID,
		}
		
	default:
		response = protocol.Error(msg.ID, "unknown message type")
	}
	
	if err := conn.WriteJSON(response); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
	
	_ = ctx // TODO: Use context for runtime calls
}

func (g *Gateway) handleSessionsAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	g.sessionLock.RLock()
	defer g.sessionLock.RUnlock()
	
	sessions := make([]map[string]interface{}, 0, len(g.sessions))
	for _, s := range g.sessions {
		sessions = append(sessions, map[string]interface{}{
			"id":         s.ID,
			"created_at": s.CreatedAt,
			"metadata":   s.Metadata,
		})
	}
	
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sessions": sessions,
		"count":    len(sessions),
	})
}
