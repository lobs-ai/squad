# Build stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build the gateway binary
RUN CGO_ENABLED=0 GOOS=linux go build -o squad-gateway ./cmd/gateway

# Runtime stage
FROM alpine:3.19

WORKDIR /app

# Install CA certificates for HTTPS
RUN apk add --no-cache ca-certificates

# Copy binary from builder
COPY --from=builder /app/squad-gateway /app/squad-gateway
COPY --from=builder /app/config.yaml.example /app/config.yaml.example

# Create non-root user
RUN adduser -D -u 1000 squad

USER squad

# Expose gateway port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run the gateway
ENTRYPOINT ["/app/squad-gateway"]
CMD ["--config", "/app/config.yaml"]
