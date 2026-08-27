FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && rm -rf /var/lib/apt/lists/*

# Create unprivileged user
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/sh -m appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Copy code with explicit ownership
COPY --chown=appuser:appgroup . .

USER appuser
EXPOSE {{PORT}}

CMD ["gunicorn", "--bind", "0.0.0.0:{{PORT}}", "--workers", "3", "your_project.wsgi:application"]