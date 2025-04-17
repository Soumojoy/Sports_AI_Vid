// API endpoint to fetch all videos from the S3 bucket
// Import required packages
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import AWS from 'aws-sdk';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Set __dirname manually (because we're using ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
dotenv.config();

// Initialize express server
const app = express();
app.use(cors()); // Enable cross-origin requests
app.use(express.json()); // Enable JSON parsing in requests

// Initialize Google Gemini AI
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

// Setup AWS Polly for text-to-speech
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1',
});
const polly = new AWS.Polly(); // Create Polly instance

const s3 = new AWS.S3(); // Create AWS S3 instance

// Folder where all audio, images, and video files will be stored locally before uploading to S3
const folderPath = path.join(__dirname, 'audio');
if (!fs.existsSync(folderPath)) {
  fs.mkdirSync(folderPath); // Create folder if not existing
}

// Set FFmpeg and FFprobe paths directly
const ffmpegPath = "C:\\Users\\soumo\\Desktop\\script generatror\\ffmpeg\\bin\\ffmpeg.exe";
const ffprobePath = "C:\\Users\\soumo\\Desktop\\script generatror\\ffmpeg\\bin\\ffprobe.exe";

// Main function to run narration + audio + images + video generation
async function run(celebrityName) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Generate script using Gemini
    const prompt = `Write a unique historical fact about ${celebrityName} in 60 to 70 words`;
    const result = await model.generateContent(prompt);
    const response = result.response;
    const narration = await response.text();

    console.log('🎙️ Narration Script:\n', narration);

    // Generate audio using AWS Polly
    const audioFile = await generateSpeech(narration);

    // Create a temporary images directory
    const tempImageDir = path.join(folderPath, 'temp_images');
    if (!fs.existsSync(tempImageDir)) {
      fs.mkdirSync(tempImageDir);
    }

    // Fetch images of the celebrity from multiple sources
    const imageFiles = await fetchBetterCelebrityImages(celebrityName, 10); // Get 10 images

    // Generate video using images and audio
    const videoPath = await generateVideoFromAudioAndImages(audioFile, imageFiles);

    // Upload video to AWS S3
    const videoUrl = await uploadVideoToS3(videoPath);

    // Clean up temporary files
    cleanupTempFiles(imageFiles, tempImageDir);

    console.log(`✅ Process completed successfully. Video uploaded to S3 at: ${videoUrl}`);

    return videoUrl;
  } catch (error) {
    console.error('❌ Error in run process:', error);
    throw error;
  }
}

// Generate audio using AWS Polly
async function generateSpeech(text) {
  const params = {
    OutputFormat: 'mp3',
    Text: text,
    VoiceId: 'Matthew',
  };

  return new Promise((resolve, reject) => {
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        console.error('❌ Polly Error:', err);
        return reject(err);
      }

      const audioFileName = `audio_${Date.now()}.mp3`;
      const audioPath = path.join(folderPath, audioFileName);
      fs.writeFileSync(audioPath, data.AudioStream);
      console.log(`✅ Audio saved as ${audioFileName}`);
      resolve(audioPath);
    });
  });
}

async function fetchBetterCelebrityImages(name, count = 10) {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;
  const downloadedImages = [];

  // Helper: download image from URL to local file
  const downloadImage = async (imageUrl, index) => {
    const imagePath = path.join(folderPath, `image_${Date.now()}_${index + 1}.jpg`);
    try {
      const imageStream = await axios.get(imageUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(imagePath);
      imageStream.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      return imagePath;
    } catch (err) {
      console.error(`❌ Error downloading image: ${err.message}`);
      return null;
    }
  };

  try {
    let startIndex = 1;

    while (downloadedImages.length < count && startIndex < 100) {
      const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
        name
      )}&searchType=image&key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}&num=10&start=${startIndex}`;

      const response = await axios.get(url);
      const items = response.data.items || [];

      if (!items.length) {
        console.log('⚠️ No more images found.');
        break;
      }

      for (const [index, item] of items.entries()) {
        if (downloadedImages.length >= count) break;

        const imageUrl = item.link;

        const savedPath = await downloadImage(imageUrl, downloadedImages.length);
        if (savedPath) {
          downloadedImages.push(savedPath);
          console.log(`✅ Downloaded image ${downloadedImages.length}/${count}`);
        }
      }

      startIndex += 10; // Move to next batch
    }

    if (downloadedImages.length === 0) {
      throw new Error('No images found for the celebrity');
    }

    console.log(`🖼️ Images saved: ${downloadedImages.length}`);
    return downloadedImages;
  } catch (err) {
    console.error('❌ Error fetching images from Google:', err.message);
    throw err;
  }
}

// Helper function to get audio duration using ffprobe
async function getAudioDuration(audioPath) {
  const command = `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;

  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) {
        console.error('❌ FFprobe Error:', err);
        // If there's an error getting the duration, return a default value
        return resolve(30); // Default to 30 seconds
      }
      const duration = parseFloat(stdout.trim());
      resolve(duration);
    });
  });
}

// Generate video using ffmpeg with images and audio
async function generateVideoFromAudioAndImages(audioPath, imagePaths) {
  const videoPath = path.join(folderPath, `video_${Date.now()}.mp4`);

  // Create temp folder for renamed images
  const tempImageDir = path.join(folderPath, 'temp_images');
  if (!fs.existsSync(tempImageDir)) {
    fs.mkdirSync(tempImageDir);
  }

  // Clean temp folder before reuse
  fs.readdirSync(tempImageDir).forEach(file => {
    fs.unlinkSync(path.join(tempImageDir, file));
  });

  // Rename and copy images as img001.jpg, img002.jpg, etc.
  imagePaths.forEach((img, index) => {
    const destPath = path.join(tempImageDir, `img${String(index + 1).padStart(3, '0')}.jpg`);
    fs.copyFileSync(img, destPath);
  });

  // Get audio duration using ffprobe
  const audioDuration = await getAudioDuration(audioPath);
  console.log(`🔊 Audio duration: ${audioDuration} seconds`);

  const durationPerImage = audioDuration / imagePaths.length; // Show each image equally based on audio length
  const inputPattern = path.join(tempImageDir, 'img%03d.jpg');

  const command = `"${ffmpegPath}" -y -i "${audioPath}" -loop 1 -framerate 1/${durationPerImage} -i "${inputPattern}" -c:v libx264 -c:a aac -b:a 192k -shortest -pix_fmt yuv420p -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" -map 0:a:0 -map 1:v:0 -t ${audioDuration} "${videoPath}"`;

  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) {
        console.error('❌ FFmpeg Error:', err);
        console.error('FFmpeg stderr:', stderr);
        return reject(err);
      }
      console.log(`🎬 Video created at ${videoPath}`);
      resolve(videoPath);
    });
  });
}

// Function to upload video to AWS S3
async function uploadVideoToS3(videoPath) {
  const fileContent = fs.readFileSync(videoPath);
  const params = {
    Bucket: process.env.S3_BUCKET_NAME, // Bucket name from .env
    Key: `videos/${path.basename(videoPath)}`,
    Body: fileContent,
    ContentType: 'video/mp4',
  };

  return new Promise((resolve, reject) => {
    s3.upload(params, (err, data) => {
      if (err) {
        console.error('❌ Error uploading to S3:', err);
        return reject(err);
      }
      console.log(`✅ Video uploaded to S3: ${data.Location}`);
      resolve(data.Location); // Return the video URL from S3
    });
  });
}

// Function to clean up temporary files
function cleanupTempFiles(imageFiles, tempImageDir) {
  try {
    console.log('🧹 Cleaning up temporary files...');
    
    // Remove temporary renamed images
    if (fs.existsSync(tempImageDir)) {
      fs.readdirSync(tempImageDir).forEach(file => {
        fs.unlinkSync(path.join(tempImageDir, file));
      });
      fs.rmdirSync(tempImageDir);
    }
    
    console.log('🧹 Cleanup completed');
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}



// ✅ New simplified endpoint that accepts an `input` and runs the full pipeline
app.post('/api/send', async (req, res) => {
  const { input } = req.body;

  if (!input) {
    return res.status(400).json({ message: 'No input provided' });
  }

  try {
    const result = await run(input);
    res.json({ message: `Video generated, check this link:`, videoUrl: result });

  } catch (error) {
    res.status(500).json({ message: 'Error generating video', error: error.message });
  }
});

// Get list of videos from S3
app.get('/api/videos', async (req, res) => {
  try {
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: 'videos/',
    };

    s3.listObjectsV2(params, (err, data) => {
      if (err) {
        return res.status(500).json({ error: 'Error fetching videos' });
      }

      const urls = data.Contents.map(item => {
        return `https://${params.Bucket}.s3.${AWS.config.region}.amazonaws.com/${item.Key}`;
      });

      res.json({ videos: urls });
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

