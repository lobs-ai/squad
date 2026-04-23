package models

import "time"

// Session represents an agent conversation session
type Session struct {
	ID        string                 `json:"id"`
	CreatedAt time.Time              `json:"created_at"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
	Messages  []Message              `json:"messages"`
}

// Message represents a single message in a session
type Message struct {
	Role      string `json:"role"` // user, assistant, system
	Content   string `json:"content"`
	Timestamp time.Time `json:"timestamp,omitempty"`
}
