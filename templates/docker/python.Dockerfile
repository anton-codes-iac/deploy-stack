FROM python:3.12-alpine

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Create a non-root user for security compliance (Alpine syntax)
RUN addgroup -S appuser && \
    adduser -S appuser -G appuser -D -s /bin/sh

# Install runtime libraries and temporary build tools
RUN apk update && \
    apk add --no-cache libpq && \
    apk add --no-cache --virtual .build-deps gcc musl-dev postgresql-dev

COPY requirements.txt .

# Upgrade pip, install dependencies, clear caches, and NUKE package managers
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements.txt && \
    find / -type d -name "ensurepip" -exec rm -rf {} + || true && \
    rm -rf /root/.cache/pip && \
    pip uninstall -y setuptools wheel pip

# Remove the build tools to shrink the image and reduce attack surface
RUN apk del .build-deps

# Copy with ownership
COPY --chown=appuser:appuser . .

# Drop root privileges
USER appuser

EXPOSE {{PORT}}

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "{{PORT}}"]