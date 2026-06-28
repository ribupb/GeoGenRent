# GeoGenRent – GeoAI-Based Intelligent Housing Explorer

GeoGenRent is a GeoAI-powered housing exploration platform for Bengaluru that combines geospatial analytics, interactive mapping, and natural language search to help users discover suitable properties based on location, price, amenities, and environmental factors.

The application integrates housing listings with spatial datasets such as metro stations, schools, hospitals, bus stops, and Air Quality Index (AQI) to provide a more informed property selection experience.

---

## Features

* Natural language property search
* Interactive Leaflet map
* Property search by:

  * Budget
  * BHK
  * Location
  * Nearby metro stations
  * Schools
  * Hospitals
  * Bus stops
* Livability Score for each property
* City Snapshot dashboard with real statistics
* Nearby amenity analysis
* Metro line and station visualization
* AQI visualization
* Property comparison tool
* Dark / Light mode

---

## Technology Stack

### Backend

* Python
* Flask
* Pandas
* NumPy
* Shapely
* Geopy

### Frontend

* HTML5
* CSS3
* JavaScript
* Leaflet.js
* Chart.js

### Spatial Data

* GeoJSON
* CSV datasets
* OpenStreetMap
* Nominatim Geocoder

---

## Project Structure

```text
GeoGenRent/
│
├── app.py
├── requirements.txt
├── templates/
│   └── index.html
├── static/
│   ├── app.js
│   ├── style.css
│   ├── metro-lines-stations.geojson
│   ├── cleaned_with_coordinates.csv
│   ├── cleaned_hospitals.csv
│   ├── cleaned_1000_schools.geojson
│   ├── bengaluru_aqi.csv
│   └── bus_stop_cleaned.csv
└── scripts/
    └── convert.py
```

---

## Installation

Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/GeoGenRent.git
cd GeoGenRent
```

Create a virtual environment

```bash
python -m venv .venv
```

Activate it

Windows

```bash
.venv\Scripts\activate
```

Install dependencies

```bash
pip install -r requirements.txt
```

Run the application

```bash
python app.py
```

Open

```text
(https://geogenrent.onrender.com)
```

---

## Screenshots

### Home Page
![Home Page](screenshots/Home.png)

### AI Chatbot
![AI Chatbot](screenshots/chat-bot.png)

### Property Details
![Property Details](screenshots/Comparison.png)

## Future Improvements

* Machine learning-based house price prediction
* Recommendation engine
* Semantic natural language search
* Route planning
* Mobile-responsive layout improvements

---

## Team

This project was developed as a group academic project by:

- Hrudya Sudhees
- Ribu P B
