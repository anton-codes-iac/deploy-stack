FROM python:3.12-slim

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Upgrade Debian OS packages to patch system-level CVEs (like python3-setuptools)
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user for security compliance
RUN adduser --disabled-password --gecos '' appuser

COPY requirements.txt .

# Upgrade core pip tools and purge downloaded caches to resolve ghost CVEs
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    rm -rf /root/.cache/pip && \
    rm -rf /usr/local/lib/python3.12/ensurepip/_bundled

# Install dependencies without caching to keep the image size small
RUN pip install --no-cache-dir -r requirements.txt

# Copy with ownership
COPY --chown=appuser:appuser . .

# Drop root privileges
USER appuser

EXPOSE {{PORT}}

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "{{PORT}}"]