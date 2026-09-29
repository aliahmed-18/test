package main

import (
	"encoding/json"
	"log"
	"sync"
)

// Event is one live update pushed to dashboards and students over Server-Sent Events.
//
//	type: "session" | "participant" | "question" | "group"
//	data: the full, current row (clients upsert by id)
type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// Hub is an in-process publish/subscribe fan-out keyed by session id.
type Hub struct {
	mu   sync.Mutex
	subs map[string]map[chan []byte]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: map[string]map[chan []byte]struct{}{}}
}

// Subscribe returns a channel of encoded events for a session and a cancel func.
func (h *Hub) Subscribe(sessionID string) (<-chan []byte, func()) {
	ch := make(chan []byte, 256)
	h.mu.Lock()
	if h.subs[sessionID] == nil {
		h.subs[sessionID] = map[chan []byte]struct{}{}
	}
	h.subs[sessionID][ch] = struct{}{}
	h.mu.Unlock()

	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if set, ok := h.subs[sessionID]; ok {
			if _, ok := set[ch]; ok {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(h.subs, sessionID)
			}
		}
	}
}

func (h *Hub) Publish(sessionID, eventType string, data any) {
	payload, err := json.Marshal(Event{Type: eventType, Data: data})
	if err != nil {
		log.Printf("hub: encode %s: %v", eventType, err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[sessionID] {
		select {
		case ch <- payload:
		default:
			// Slow client: drop it. Its browser reconnects and reloads a fresh snapshot.
			delete(h.subs[sessionID], ch)
			close(ch)
		}
	}
}
