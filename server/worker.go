package main

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

// Worker classifies questions asynchronously. Each session is drained by at
// most one goroutine at a time, so concurrent submissions are classified in
// order and two paraphrases can never each create their own group.
type Worker struct {
	store      *Store
	hub        *Hub
	classifier *Classifier
	cfg        Config

	mu      sync.Mutex
	running map[string]*sessionRun
	wg      sync.WaitGroup
}

type sessionRun struct {
	dirty bool // new work arrived while draining
}

func NewWorker(store *Store, hub *Hub, classifier *Classifier, cfg Config) *Worker {
	return &Worker{store: store, hub: hub, classifier: classifier, cfg: cfg, running: map[string]*sessionRun{}}
}

// Kick asks for a session's pending questions to be classified. Never blocks.
func (w *Worker) Kick(ctx context.Context, sessionID string) {
	w.mu.Lock()
	if run, ok := w.running[sessionID]; ok {
		run.dirty = true
		w.mu.Unlock()
		return
	}
	run := &sessionRun{}
	w.running[sessionID] = run
	w.mu.Unlock()

	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		for {
			w.drain(ctx, sessionID)
			w.mu.Lock()
			if run.dirty && ctx.Err() == nil {
				run.dirty = false
				w.mu.Unlock()
				continue
			}
			delete(w.running, sessionID)
			w.mu.Unlock()
			return
		}
	}()
}

// Run recovers abandoned work and periodically sweeps for questions that still
// need classifying (e.g. after an AI outage). Blocks until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	if err := w.store.RecoverAbandoned(ctx); err != nil {
		log.Printf("worker: recover abandoned questions: %v", err)
	}
	ticker := time.NewTicker(w.cfg.SweepInterval)
	defer ticker.Stop()
	for {
		w.sweep(ctx)
		select {
		case <-ctx.Done():
			w.wg.Wait()
			return
		case <-ticker.C:
		}
	}
}

func (w *Worker) sweep(ctx context.Context) {
	ids, err := w.store.SessionsWithPendingWork(ctx, w.cfg.MaxAttempts)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("worker: sweep: %v", err)
		}
		return
	}
	for _, id := range ids {
		w.Kick(ctx, id)
	}
}

func (w *Worker) drain(ctx context.Context, sessionID string) {
	for ctx.Err() == nil {
		q, err := w.store.ClaimNextQuestion(ctx, sessionID, w.cfg.MaxAttempts)
		if errors.Is(err, ErrNotFound) {
			return
		}
		if err != nil {
			log.Printf("worker: claim question in %s: %v", sessionID, err)
			return
		}
		w.hub.Publish(sessionID, "question", q) // shows "Analyzing…"

		if err := w.classify(ctx, q); err != nil {
			log.Printf("worker: classification failed for %s (attempt %d): %v", q.ID, q.ClassificationAttempts, err)
			// Never lose the question: put it back to pending with the error recorded.
			failed, markErr := w.store.MarkFailed(context.WithoutCancel(ctx), q.ID, err.Error())
			if markErr != nil {
				log.Printf("worker: mark failed %s: %v", q.ID, markErr)
			} else {
				w.hub.Publish(sessionID, "question", failed)
			}
			if errors.Is(err, ErrClassifierUnavailable) {
				// Don't hammer a service that is down; the periodic sweep retries later.
				return
			}
		}
	}
}

func (w *Worker) classify(ctx context.Context, q Question) error {
	groups, err := w.store.GroupContexts(ctx, q.SessionID, w.cfg.ExamplesPerGroup)
	if err != nil {
		return err
	}
	decision, err := w.classifier.Classify(ctx, q.Text, groups)
	if err != nil {
		return err
	}

	var updated Question
	var group Group
	if decision.GroupID != "" {
		updated, group, err = w.store.AssignToGroup(ctx, q.ID, decision.GroupID, decision.RepresentativeQuestion)
	} else {
		updated, group, err = w.store.AssignToNewGroup(ctx, q.ID, q.SessionID, decision.Title, decision.RepresentativeQuestion)
	}
	if err != nil {
		return err
	}
	// Publish the group first so the question's group_id always resolves on the client.
	w.hub.Publish(q.SessionID, "group", group)
	w.hub.Publish(q.SessionID, "question", updated)

	outcome := "existing \"" + group.Title + "\""
	if decision.GroupID == "" {
		outcome = "new \"" + group.Title + "\""
	}
	log.Printf("classified %q -> %s (similarity %.2f, threshold %.2f): %s",
		q.Text, outcome, decision.Similarity, w.cfg.SimilarityThreshold, decision.Reasoning)
	return nil
}
