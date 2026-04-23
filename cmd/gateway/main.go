package main

import (
	"log"
	"os"

	"github.com/lobs-ai/squad/internal/gateway"
	"github.com/spf13/viper"
)

func main() {
	// Load configuration
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.AddConfigPath("/app")

	// Environment variable overrides
	viper.AutomaticEnv()

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); ok {
			// Use defaults if no config found
			log.Println("No config file found, using defaults")
		} else {
			log.Fatalf("Failed to read config: %v", err)
		}
	}

	// Start the gateway
	g := gateway.New()
	if err := g.Start(); err != nil {
		log.Fatalf("Gateway failed: %v", err)
	}
}
