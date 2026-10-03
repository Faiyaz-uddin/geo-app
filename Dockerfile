# Use official Python 3.10 slim image as base
FROM python:3.10-slim

# Set working directory inside container
WORKDIR /geo-app

# Copy requirements into container
COPY requirements.txt .

# Install dependencies (no cache for smaller image size)
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code into container
COPY . .

# Expose port (Flask default is 5000)
EXPOSE 5000

# Command to run the app
CMD ["python", "app.py"]
