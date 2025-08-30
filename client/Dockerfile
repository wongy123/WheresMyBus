# Use a minimal, official Python image
FROM python:3.12-slim

# Set environment variables to optimize Python's behavior in a container
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=

# Set the working directory for subsequent commands
WORKDIR /app

# Install dependencies first for better Docker caching
# A single layer is created for the dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Set Flask environment variables
ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0
ENV FLASK_RUN_PORT=5000

# Expose the port the app runs on
EXPOSE 5000

# # Command to run the Flask development server
# CMD ["flask", "run"]

# Command to run Gunicorn with multiple workers
# This uses the number of CPU cores * 2 + 1, a common recommendation for Gunicorn workers.
CMD ["gunicorn", "--workers", "5", "--bind", "0.0.0.0:5000", "app:app"]