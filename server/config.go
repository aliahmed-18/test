package main

import (
	"os"
	"strconv"
	"time"
)

// Config holds every tunable of the server. Everything can be set through
// environment variables so the AI behaviour can be adjusted during testing
// without code changes.
type Config struct {
	Addr        string // HTTP listen address, e.g. ":8080"
	DatabaseURL string // Postgres connection string
	StaticDir   string // built frontend (vite build output); empty disables static serving

	AnthropicAPIKey string

	// Minimum similarity (0–1) the model must report for a question to join an
	// existing group. Lower = more aggressive merging, higher = more groups.
	//   ~0.9  only near-paraphrases merge
	//   ~0.65 same underlying concept merges (constructor what/when/why)  <- default
	//   ~0.4  loosely related topics merge (constructor + getter) – too coarse
	SimilarityThreshold float64
	ClassifierModel     string        // Claude model id
	ClassifierEffort    string        // low | medium | high
	ExamplesPerGroup    int           // example questions per group shown to the model
	MaxAttempts         int           // automatic attempts before "Classification pending"
	ClassifierTimeout   time.Duration // per Claude request
	SweepInterval       time.Duration // how often to look for questions that still need classifying
}

func LoadConfig() Config {
	port := env("PORT", "8080")
	return Config{
		Addr:                env("ADDR", ":"+port),
		DatabaseURL:         env("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/getit?sslmode=disable"),
		StaticDir:           env("STATIC_DIR", "../dist"),
		AnthropicAPIKey:     os.Getenv("ANTHROPIC_API_KEY"),
		SimilarityThreshold: envFloat("SIMILARITY_THRESHOLD", 0.65),
		ClassifierModel:     env("CLASSIFIER_MODEL", "claude-opus-5"),
		ClassifierEffort:    env("CLASSIFIER_EFFORT", "low"),
		ExamplesPerGroup:    envInt("CLASSIFIER_EXAMPLES_PER_GROUP", 5),
		MaxAttempts:         envInt("CLASSIFIER_MAX_ATTEMPTS", 3),
		ClassifierTimeout:   45 * time.Second,
		SweepInterval:       20 * time.Second,
	}
}

func env(name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok && v != "" {
		return v
	}
	return fallback
}

func envFloat(name string, fallback float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return fallback
}
