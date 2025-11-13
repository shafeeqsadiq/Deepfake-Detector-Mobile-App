const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const FormData = require('form-data');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const getFBInfo = require('@xaviabot/fb-downloader');
const TiktokDL = require('@tobyg74/tiktok-api-dl');
const snapsave = require('./snapsave-downloader/src/index');
require('dotenv').config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

const app = express();
const PORT = process.env.PORT || 3002; // Use Render's PORT or 3002 for local

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Root endpoint - health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Deepfake Detector API is running',
    status: 'healthy',
    endpoints: {
      analyze: 'POST /analyze',
      analyzeVideo: 'POST /analyze-video',
      analyzeVideoUrl: 'POST /analyze-video-url',
      proxy: 'GET /proxy'
    }
  });
});

// Proxy endpoint for URL fetching (same as web app)
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Error: The "url" query parameter is missing.');
  }

  console.log(`📱 Proxying request for URL: ${targetUrl}`);

  try {
    const response = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Deepfake-Detector-Mobile/1.0' }
    });

    if (!response.ok) {
      console.error(`Fetch failed: ${response.status} ${response.statusText}`);
      return res.status(response.status).send(`Error fetching the URL: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    response.body.pipe(res);
  } catch (error) {
    console.error('Proxy server error:', error.message);
    res.status(500).send(`Server error: Could not proxy the request. ${error.message}`);
  }
});

// Deepfake detection endpoint
app.post('/analyze', async (req, res) => {
  const { base64, mimeType } = req.body;

  if (!base64 || !mimeType) {
    return res.status(400).json({ error: 'Missing base64 or mimeType' });
  }

  const SIGHTENGINE_API_USER = process.env.SIGHTENGINE_API_USER;
  const SIGHTENGINE_API_SECRET = process.env.SIGHTENGINE_API_SECRET;

  console.log('📱 Mobile app analysis request');
  console.log('MIME Type:', mimeType);

  try {
    if (!SIGHTENGINE_API_USER || !SIGHTENGINE_API_SECRET) {
      return res.status(500).json({ 
        error: 'API credentials not configured. Add them to backend/.env file' 
      });
    }

    // Handle base64 with or without data URI prefix
    const base64Data = base64.includes('base64,') 
      ? base64.split('base64,')[1] 
      : base64;
    
    console.log('Base64 first 50 chars:', base64Data.substring(0, 50));
    console.log('Base64 valid?', /^[A-Za-z0-9+/=]+$/.test(base64Data.substring(0, 100)));
    
    const imageBuffer = Buffer.from(base64Data, 'base64');
    console.log('Image size:', imageBuffer.length, 'bytes');

    // Create form data (exactly like web app)
    const form = new FormData();
    form.append('media', imageBuffer, {
      filename: 'image.jpg',
      contentType: mimeType,
    });
    form.append('models', 'genai');
    form.append('api_user', SIGHTENGINE_API_USER);
    form.append('api_secret', SIGHTENGINE_API_SECRET);

    // Call Sightengine API
    const response = await fetch('https://api.sightengine.com/1.0/check.json', {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });

    const result = await response.json();
    console.log('Sightengine response:', result);

    if (result.status === 'failure') {
      throw new Error(result.error?.message || 'API request failed');
    }

    // Parse response (exactly like web app)
    const aiScore = result.type?.ai_generated || 0;
    const isFake = aiScore > 0.5;
    const confidence = aiScore;

    const artifacts = [];
    if (result.type?.ai_class) {
      artifacts.push(`AI class: ${result.type.ai_class}`);
    }
    if (isFake && aiScore > 0.8) {
      artifacts.push('High confidence AI generation detected');
    }
    if (isFake && aiScore > 0.6 && aiScore <= 0.8) {
      artifacts.push('Moderate AI generation indicators');
    }

    const analysisResult = {
      is_likely_ai_generated: isFake,
      confidence_score: confidence,
      reasoning: isFake
        ? `Sightengine AI detection model identified this as likely AI-generated with ${(confidence * 100).toFixed(1)}% confidence. The image shows characteristics typical of synthetic media.`
        : `Sightengine AI detection model identified this as likely authentic with ${((1 - confidence) * 100).toFixed(1)}% confidence. No significant AI generation indicators detected.`,
      potential_artifacts: artifacts,
    };

    res.json(analysisResult);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to analyze media',
      details: error.message
    });
  }
});

// Video analysis endpoint using Cloudinary + Sightengine
app.post('/analyze-video', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing video file' });
  }

  const SIGHTENGINE_API_USER = process.env.SIGHTENGINE_API_USER;
  const SIGHTENGINE_API_SECRET = process.env.SIGHTENGINE_API_SECRET;

  console.log('📹 Video analysis request');
  console.log('Video file size:', req.file.size, 'bytes');

  try {
    if (!SIGHTENGINE_API_USER || !SIGHTENGINE_API_SECRET) {
      return res.status(500).json({ 
        error: 'Sightengine API credentials not configured' 
      });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(500).json({ 
        error: 'Cloudinary not configured. Add credentials to .env file' 
      });
    }

    // Step 1: Upload video to Cloudinary
    console.log('Uploading video to Cloudinary...');
    console.log('Video file:', req.file.path);
    
    const uploadResult = await cloudinary.uploader.upload(
      req.file.path,
      {
        resource_type: 'video',
        folder: 'deepfake-detector',
        public_id: `video_${Date.now()}`,
      }
    );

    const videoUrl = uploadResult.secure_url;
    console.log('Video uploaded:', videoUrl);
    
    // Delete local temp file
    fs.unlinkSync(req.file.path);

    // Step 2: Analyze video with Sightengine (synchronous check-sync endpoint)
    console.log('🔍 Analyzing video with Sightengine (this may take a minute)...');
    
    const analyzeUrl = `https://api.sightengine.com/1.0/video/check-sync.json`;
    
    const formData = new FormData();
    formData.append('stream_url', videoUrl);
    formData.append('models', 'genai');
    formData.append('api_user', SIGHTENGINE_API_USER);
    formData.append('api_secret', SIGHTENGINE_API_SECRET);
    
    const analyzeResponse = await fetch(analyzeUrl, {
      method: 'POST',
      body: formData
    });
    
    const result = await analyzeResponse.json();
    console.log('Sightengine analysis response:', JSON.stringify(result, null, 2));

    if (result.status === 'failure') {
      throw new Error(result.error?.message || 'Video analysis failed');
    }

    // Step 3: Delete video from Cloudinary (cleanup)
    console.log('Cleaning up - deleting video from Cloudinary...');
    await cloudinary.uploader.destroy(uploadResult.public_id, {
      resource_type: 'video'
    });

    // Parse results - average across all frames
    const frames = result.data?.frames || [];
    const aiScores = frames
      .map(frame => frame.type?.ai_generated || 0)
      .filter(score => score > 0);
    
    const aiScore = aiScores.length > 0 
      ? aiScores.reduce((a, b) => a + b, 0) / aiScores.length 
      : 0;
    
    const isFake = aiScore > 0.5;
    const confidence = aiScore;

    const analysisResult = {
      is_likely_ai_generated: isFake,
      confidence_score: confidence,
      reasoning: isFake
        ? `Video analysis detected this as likely AI-generated with ${(confidence * 100).toFixed(1)}% confidence. The video shows characteristics typical of synthetic media.`
        : `Video analysis detected this as likely authentic with ${((1 - confidence) * 100).toFixed(1)}% confidence. No significant AI generation indicators detected.`,
      potential_artifacts: isFake ? ['AI-generated video patterns detected'] : [],
    };

    res.json(analysisResult);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to analyze video',
      details: error.message
    });
  }
});

// Helper function to extract direct video URL from social media
async function getDirectVideoUrl(url) {
  console.log('Extracting video URL from:', url);
  
  // Check platform
  if (url.includes('instagram.com')) {
    console.log('Detected Instagram URL');
    
    try {
      console.log('Using snapsave Instagram downloader...');
      const result = await snapsave(url);
      
      // Response format: { developer: "...", status: true, data: [{ url: "...", thumbnail: "..." }] }
      if (result.status && result.data && result.data.length > 0) {
        const videoUrl = result.data[0].url;
        console.log('✅ Extracted Instagram video URL successfully');
        return videoUrl;
      }
      
      throw new Error(result.msg || 'Could not extract video from Instagram URL');
    } catch (error) {
      console.log('⚠️ Instagram extraction failed:', error.message);
      throw new Error('Could not extract video from Instagram URL. Please use file upload instead.');
    }
  }
  
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    console.log('Detected Facebook URL');
    try {
      const result = await getFBInfo(url);
      if (result && result.sd) {
        console.log('✅ Extracted video URL successfully');
        return result.sd;
      }
      if (result && result.hd) {
        console.log('✅ Extracted HD video URL successfully');
        return result.hd;
      }
      throw new Error('Could not extract video from Facebook URL');
    } catch (error) {
      console.log('⚠️ Facebook extraction failed:', error);
      throw new Error('Could not extract video from Facebook URL. Please use file upload instead.');
    }
  }
  
  if (url.includes('tiktok.com')) {
    console.log('Detected TikTok URL');
    try {
      const result = await TiktokDL.Downloader(url, { version: 'v1' });
      if (result.status === 'success' && result.result?.video) {
        console.log('✅ Extracted TikTok video URL successfully');
        return result.result.video;
      }
      throw new Error('Could not extract video from TikTok URL');
    } catch (error) {
      console.log('⚠️ TikTok extraction failed:', error.message);
      throw new Error('Could not extract video from TikTok URL. Please use file upload instead.');
    }
  }
  
  // For other URLs, assume it's a direct video link
  console.log('Assuming direct video URL');
  return url;
}

// Video URL analysis endpoint
app.post('/analyze-video-url', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: 'Missing video URL' });
  }

  const SIGHTENGINE_API_USER = process.env.SIGHTENGINE_API_USER;
  const SIGHTENGINE_API_SECRET = process.env.SIGHTENGINE_API_SECRET;

  console.log('📹 Video URL analysis request');
  console.log('Original URL:', videoUrl);

  try {
    if (!SIGHTENGINE_API_USER || !SIGHTENGINE_API_SECRET) {
      return res.status(500).json({ 
        error: 'Sightengine API credentials not configured' 
      });
    }

    // Step 1: Extract direct video URL from social media
    let directVideoUrl;
    try {
      directVideoUrl = await getDirectVideoUrl(videoUrl);
      console.log('✅ Direct video URL extracted:', directVideoUrl);
    } catch (error) {
      console.log('⚠️ Could not extract video URL:', error.message);
      return res.status(400).json({ 
        error: error.message,
        suggestion: 'Use the "Upload Video" option in the app instead'
      });
    }

    // Step 2: Download the video from the extracted URL
    console.log('📥 Downloading video from extracted URL...');
    
    let videoResponse;
    try {
      videoResponse = await axios({
        method: 'GET',
        url: directVideoUrl,
        responseType: 'stream'
      });
    } catch (error) {
      console.log('⚠️ Failed to download video:', error.message);
      return res.status(500).json({ 
        error: 'Failed to download video from URL',
        details: error.message
      });
    }

    // Step 3: Save video temporarily
    const tempFileName = `temp_video_${Date.now()}.mp4`;
    const tempFilePath = path.join(__dirname, 'uploads', tempFileName);
    const writer = fs.createWriteStream(tempFilePath);
    
    videoResponse.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log('✅ Video downloaded to:', tempFilePath);

    // Step 4: Upload to Cloudinary
    console.log('☁️ Uploading video to Cloudinary...');
    let cloudinaryResult;
    try {
      cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
        resource_type: 'video',
        folder: 'deepfake-detector'
      });
      console.log('✅ Video uploaded to Cloudinary:', cloudinaryResult.secure_url);
    } catch (error) {
      // Clean up temp file
      fs.unlinkSync(tempFilePath);
      console.log('⚠️ Cloudinary upload failed:', error.message);
      return res.status(500).json({ 
        error: 'Failed to upload video to cloud storage',
        details: error.message
      });
    }

    // Clean up temp file
    fs.unlinkSync(tempFilePath);
    console.log('🗑️ Temp file cleaned up');

    // Step 5: Analyze video with Sightengine (synchronous check-sync endpoint)
    const cloudinaryUrl = cloudinaryResult.secure_url;
    console.log('🔍 Analyzing video with Sightengine (this may take a minute)...');
    
    // Use check-sync for synchronous analysis (waits for result)
    const analyzeUrl = `https://api.sightengine.com/1.0/video/check-sync.json`;
    
    const formData = new FormData();
    formData.append('stream_url', cloudinaryUrl);
    formData.append('models', 'genai');
    formData.append('api_user', SIGHTENGINE_API_USER);
    formData.append('api_secret', SIGHTENGINE_API_SECRET);
    
    const analyzeResponse = await fetch(analyzeUrl, {
      method: 'POST',
      body: formData
    });
    
    const result = await analyzeResponse.json();
    console.log('Sightengine analysis response:', JSON.stringify(result, null, 2));

    if (result.status === 'failure') {
      throw new Error(result.error?.message || 'Video analysis failed');
    }

    // Parse synchronous response
    if (!result.data || !result.data.frames || result.data.frames.length === 0) {
      console.error('No frame data in response');
      throw new Error('Video analysis returned no frame data.');
    }

    // Parse results - average across all frames
    const frames = result.data.frames;
    const aiScores = frames
      .map(frame => frame.type?.ai_generated || 0)
      .filter(score => score > 0);
    
    console.log('AI scores from frames:', aiScores);
    
    const aiScore = aiScores.length > 0 
      ? aiScores.reduce((a, b) => a + b, 0) / aiScores.length 
      : 0;
    
    const isFake = aiScore > 0.5;
    const confidence = aiScore;
    
    console.log('Final AI score:', aiScore);

    const analysisResult = {
      is_likely_ai_generated: isFake,
      confidence_score: confidence,
      reasoning: isFake
        ? `Video analysis detected this as likely AI-generated with ${(confidence * 100).toFixed(1)}% confidence.`
        : `Video analysis detected this as likely authentic with ${((1 - confidence) * 100).toFixed(1)}% confidence.`,
      potential_artifacts: isFake ? ['AI-generated video patterns detected'] : [],
    };

    res.json(analysisResult);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to analyze video',
      details: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Mobile app backend running on http://localhost:${PORT}`);
  console.log(`📱 Access from phone: http://YOUR_IP:${PORT}`);
});
