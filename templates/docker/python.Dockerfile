FROM python:3.11-slim

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Create a non-root user for security compliance
RUN adduser --disabled-password --gecos '' appuser

# Install dependencies without caching to keep the image size small
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Secure file permissions
RUN chown -R appuser:appuser /app

# Drop root privileges
USER appuser

EXPOSE {{PORT}}

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "{{PORT}}"]