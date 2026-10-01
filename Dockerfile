# Python 3.11 (runtime.txt): the anthropic SDK needs 3.10 or newer
FROM python:3.11.9-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first to leverage Docker cache
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY backend backend/
COPY templates templates/
COPY static static/
COPY data data/
COPY main.py .

# Expose the port the app runs on
EXPOSE 5000

# Command to run the application
CMD ["hypercorn", "main:app", "--bind", "0.0.0.0:5000"]