FROM python:3.12-slim

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && rm -rf /var/lib/apt/lists/*

# Create unprivileged user
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/sh -m appuser

COPY requirements.txt .

# Patch core python packaging tools to resolve CVEs
RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Copy code with explicit ownership
COPY --chown=appuser:appgroup . .

USER appuser
EXPOSE {{PORT}}

# Run Gunicorn using the dynamically injected WSGI module
CMD ["gunicorn", "--bind", "0.0.0.0:{{PORT}}", "--workers", "3", "{{DJANGO_WSGI}}:application"]