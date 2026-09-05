FROM python:3.12-alpine

# --- DevSecOps Patch: Upgrade Alpine system packages to clear OS-level CVEs ---
RUN apk upgrade --no-cache

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Create unprivileged user (Alpine syntax)
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

# Install runtime libraries and temporary build tools
RUN apk update && \
    apk add --no-cache libpq && \
    apk add --no-cache --virtual .build-deps gcc musl-dev postgresql-dev

COPY requirements.txt .

# Upgrade pip, install dependencies, clear caches, and NUKE package managers
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements.txt gunicorn && \
    find / -type d -name "ensurepip" -exec rm -rf {} + || true && \
    rm -rf /root/.cache/pip && \
    pip uninstall -y setuptools wheel pip

# Remove the build tools to shrink the image and reduce attack surface
RUN apk del .build-deps

# Copy code with explicit ownership
COPY --chown=appuser:appgroup . .

USER appuser
EXPOSE {{PORT}}

# Run Gunicorn using the dynamically injected WSGI module
CMD ["gunicorn", "--bind", "0.0.0.0:{{PORT}}", "--workers", "3", "{{DJANGO_WSGI}}:application"]