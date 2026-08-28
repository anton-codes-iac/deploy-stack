FROM python:3.12-slim

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Create a non-root user for security compliance
RUN adduser --disabled-password --gecos '' appuser

# Install dependencies without caching to keep the image size small
COPY requirements.txt .

# Upgrade core pip tools to resolve base image CVEs
RUN pip install --upgrade pip setuptools wheel

# Install dependencies without caching to keep the image size small
RUN pip install --no-cache-dir -r requirements.txt

# Copy with ownership
COPY --chown=appuser:appuser . .

# Drop root privileges
USER appuser

EXPOSE {{PORT}}

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "{{PORT}}"]