# Deepfake Detector Backend

Backend API for the Deepfake Detector mobile app.

## Features

- Image deepfake detection
- Video deepfake detection
- Instagram/TikTok/Facebook URL analysis
- Social media video downloader integration

## Tech Stack

- Node.js + Express
- Sightengine API (AI detection)
- Cloudinary (video storage)
- Snapsave (Instagram downloader)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

3. Add your API credentials to `.env`

4. Run locally:

```bash
npm start
```

Server runs on http://localhost:3002

## Environment Variables

Required:

- `SIGHTENGINE_API_USER` - Sightengine API user
- `SIGHTENGINE_API_SECRET` - Sightengine API secret
- `CLOUDINARY_CLOUD_NAME` - Cloudinary cloud name
- `CLOUDINARY_API_KEY` - Cloudinary API key
- `CLOUDINARY_API_SECRET` - Cloudinary API secret

## API Endpoints

- `POST /analyze` - Analyze image (base64)
- `POST /analyze-video` - Analyze video file
- `POST /analyze-video-url` - Analyze video from URL
- `GET /proxy` - Proxy for fetching images

## Deployment

Deployed on Render.com
