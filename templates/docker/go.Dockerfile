# Stage 1: Compile
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /main .

# Stage 2: Production runner
FROM alpine:3.20
WORKDIR /app

# Create unprivileged user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Copy compiled binary with explicit ownership
COPY --from=builder --chown=appuser:appgroup /main /main

USER appuser
EXPOSE {{PORT}}

CMD ["/main"]