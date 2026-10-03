# Overhead

Weather, place and space details for any spot on Earth. Flask backend, no build step.

## Run

    python -m venv .venv
    source .venv/bin/activate        # Windows: .venv\Scripts\activate
    pip install -r requirements.txt
    python app.py

Open http://127.0.0.1:5000

## Configure

Put your keys in `.env` (already created):

    OPENWEATHER_API_KEY=your_key
    NASA_API_KEY=DEMO_KEY            # optional, free key at api.nasa.gov

## Data sources

- OpenWeather: geocoding, current weather, 5-day forecast, air quality
- Open-Meteo: elevation
- wheretheiss.at: live ISS position and orbit path
- Open Notify: people currently in space
- NASA APOD: picture of the day
- Moon phase is computed locally
