package protocol

// Message represents a message in the gateway protocol
type Message struct {
	Type    string                 `json:"type"`
	ID      string                 `json:"id"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

// Error creates an error response message
func Error(requestID string, errMsg string) Message {
	return Message{
		Type: "error",
		ID:   requestID,
		Payload: map[string]interface{}{
			"error": errMsg,
		},
	}
}
