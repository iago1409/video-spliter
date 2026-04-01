import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath.path) {
  ffmpeg.setFfprobePath(ffprobePath.path);
}

const app = express();

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - ${req.get('content-length')} bytes`);
  next();
});

// Global JSON and URL-encoded body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Job tracking for long-running processes
interface Job {
  id: string;
  status: 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
  downloadUrl?: string;
  zipSize?: number;
}
const jobs = new Map<string, Job>();

// Periodic cleanup for jobs older than 2 hours
setInterval(() => {
  const now = Date.now();
  // We don't store timestamps in Job interface yet, let's add it or just clear everything occasionally
  // Actually, the setTimeout inside processVideoJob handles successful/error cleanups.
  // This is just a safety net.
  console.log(`Limpando jobs antigos... Total atual: ${jobs.size}`);
  if (jobs.size > 100) {
     // If we have too many jobs, clear the oldest ones or just clear all if they are likely stale
     // For now, let's just log. The setTimeout is better.
  }
}, 1000 * 60 * 60);

// Ensure uploads directory exists and is clean on startup
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
} else {
  // Clean old files on startup
  const files = fs.readdirSync(uploadsDir);
  for (const file of files) {
    const filePath = path.join(uploadsDir, file);
    try {
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.error(`Erro ao limpar arquivo inicial ${file}:`, e);
    }
  }
}

const upload = multer({ 
  dest: uploadsDir,
  limits: { 
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit
    fieldSize: 10 * 1024 * 1024 // 10MB for other fields
  }
});

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: !!ffmpegPath });
});

// API: Upload chunk
app.post('/api/upload-chunk', (req, res, next) => {
  upload.single('chunk')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Erro Multer (chunk):', err);
      return res.status(400).json({ error: `Erro no upload: ${err.message}` });
    } else if (err) {
      console.error('Erro desconhecido no upload do chunk:', err);
      return res.status(500).json({ error: 'Erro interno no upload do chunk' });
    }
    next();
  });
}, (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  console.log(`Recebendo chunk ${chunkIndex} para upload ${uploadId}`);
  
  if (!req.file || !uploadId || chunkIndex === undefined) {
    console.error('Dados do chunk incompletos:', { hasFile: !!req.file, uploadId, chunkIndex });
    return res.status(400).json({ error: 'Dados do chunk incompletos' });
  }

  try {
    const chunkDir = path.join(uploadsDir, `chunks_${uploadId}`);
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }

    const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
    try {
      fs.renameSync(req.file.path, chunkPath);
    } catch (renameErr: any) {
      if (renameErr.code === 'EXDEV') {
        fs.copyFileSync(req.file.path, chunkPath);
        fs.unlinkSync(req.file.path);
      } else {
        throw renameErr;
      }
    }
    console.log(`Chunk ${chunkIndex} salvo com sucesso em ${chunkPath}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`Erro ao salvar chunk ${chunkIndex}:`, err);
    res.status(500).json({ error: `Erro ao salvar chunk: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// API: Finalize upload and split
app.post('/api/finalize-upload', async (req, res) => {
  const { uploadId, fileName, totalChunks, parts, splitMode, minutes } = req.body;
  if (!uploadId || !fileName || totalChunks === undefined) {
    return res.status(400).json({ error: 'Dados de finalização incompletos' });
  }

  // Create a background job
  const jobId = uploadId;
  jobs.set(jobId, { id: jobId, status: 'processing', progress: 0 });

  // Start processing in the background
  processVideoJob(jobId, fileName, totalChunks, parts, splitMode, minutes).catch(err => {
    console.error(`Erro fatal no job ${jobId}:`, err);
    jobs.set(jobId, { 
      id: jobId, 
      status: 'error', 
      progress: 0, 
      error: err instanceof Error ? err.message : String(err) 
    });
  });

  // Return immediately with the jobId
  res.json({ success: true, jobId });
});

async function processVideoJob(uploadId: string, fileName: string, totalChunks: number, parts: any, splitMode: string, minutes: any) {
  const sanitizedFileName = fileName.replace(/[^a-z0-9.]/gi, '_');
  const chunkDir = path.join(uploadsDir, `chunks_${uploadId}`);
  const inputPath = path.join(uploadsDir, `input_${uploadId}_${sanitizedFileName}`);
  const outputDir = path.join(uploadsDir, `split_${uploadId}`);
  const zipPath = path.join(uploadsDir, `final_${uploadId}.zip`);

  try {
    const updateJob = (data: Partial<Job>) => {
      const current = jobs.get(uploadId);
      if (current) jobs.set(uploadId, { ...current, ...data });
    };

    // Concatenate chunks using streams for better performance with large files
    console.log(`Job ${uploadId}: Concatenando ${totalChunks} chunks...`);
    updateJob({ progress: 10 });
    
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    
    const writeStream = fs.createWriteStream(inputPath);
    
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.end();
        throw new Error(`Chunk ${i} faltando no servidor. O upload pode ter falhado.`);
      }
      const chunkBuffer = fs.readFileSync(chunkPath);
      writeStream.write(chunkBuffer);
      fs.unlinkSync(chunkPath); 
    }
    
    writeStream.end();
    await new Promise((resolve, reject) => {
      writeStream.on('finish', () => resolve(null));
      writeStream.on('error', reject);
    });

    const stats = fs.statSync(inputPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`Job ${uploadId}: Arquivo concatenado (${sizeMB} MB).`);
    updateJob({ progress: 30 });
    
    if (stats.size === 0) {
      throw new Error('O arquivo final está vazio após a concatenação.');
    }

    if (fs.existsSync(chunkDir)) {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    }
    
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const originalName = fileName.replace(/\.[^/.]+$/, "");

    // Validate video and get duration
    const duration: number = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          console.error(`Job ${uploadId}: Erro no ffprobe:`, err);
          reject(new Error('O arquivo enviado não parece ser um vídeo válido ou está corrompido.'));
        } else {
          const d = metadata.format.duration;
          if (!d || d <= 0) {
            reject(new Error('Não foi possível determinar a duração do vídeo.'));
          } else {
            resolve(d);
          }
        }
      });
    });

    console.log(`Job ${uploadId}: Duração: ${duration}s. Modo: ${splitMode || 'parts'}`);
    updateJob({ progress: 40 });
    
    let segmentTime: number;
    if (splitMode === 'minutes') {
      segmentTime = (parseFloat(minutes) || 1) * 60;
    } else {
      const numParts = parseInt(parts) || 1;
      segmentTime = duration / numParts;
    }

    // Split into segments with more robust options
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-f', 'segment',
          '-segment_time', segmentTime.toString(),
          '-c', 'copy',
          '-map', '0',
          '-segment_format_options', 'movflags=+faststart',
          '-avoid_negative_ts', 'make_zero',
          '-reset_timestamps', '1',
          '-ignore_unknown'
        ])
        .output(path.join(outputDir, 'part_%d.mp4'))
        .on('start', (command) => {
          console.log(`Job ${uploadId}: Comando FFmpeg:`, command);
        })
        .on('end', () => {
          console.log(`Job ${uploadId}: FFmpeg concluído`);
          resolve(null);
        })
        .on('error', (err) => {
          console.error(`Job ${uploadId}: Erro FFmpeg:`, err);
          reject(new Error(`Erro ao dividir o vídeo: ${err.message}`));
        })
        .run();
    });

    updateJob({ progress: 70 });

    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4'));
    console.log(`Job ${uploadId}: Encontrados ${files.length} segmentos`);

    // Validate segment sizes
    const segmentInfos = files.map(f => {
      const s = fs.statSync(path.join(outputDir, f));
      return { name: f, size: s.size };
    });

    const validFiles = segmentInfos.filter(info => info.size > 1024 * 10); // At least 10KB
    
    if (validFiles.length === 0) {
      if (files.length > 0) {
        const totalSize = segmentInfos.reduce((acc, curr) => acc + curr.size, 0);
        throw new Error(`Os segmentos foram gerados mas são muito pequenos (Total: ${(totalSize / 1024).toFixed(2)} KB). Verifique o formato do vídeo.`);
      }
      throw new Error('Nenhum segmento foi gerado pelo FFmpeg. Tente outro formato ou verifique o arquivo.');
    }

    // Create ZIP on disk first
    console.log(`Job ${uploadId}: Criando arquivo ZIP...`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 0 } });

    await new Promise((resolve, reject) => {
      output.on('close', () => resolve(null));
      archive.on('error', (err) => {
        console.error(`Job ${uploadId}: Erro no Archiver:`, err);
        reject(err);
      });
      archive.pipe(output);

      const sortedFiles = validFiles.map(f => f.name).sort((a, b) => {
        const matchA = a.match(/\d+/);
        const matchB = b.match(/\d+/);
        const numA = matchA ? parseInt(matchA[0]) : 0;
        const numB = matchB ? parseInt(matchB[0]) : 0;
        return numA - numB;
      });

      sortedFiles.forEach((file, index) => {
        const filePath = path.join(outputDir, file);
        archive.file(filePath, { name: `${index + 1}.mp4` });
      });

      archive.finalize();
    });

    const zipStats = fs.statSync(zipPath);
    console.log(`Job ${uploadId}: ZIP criado (${(zipStats.size / 1024 / 1024).toFixed(2)} MB).`);
    
    if (zipStats.size < 100) {
      throw new Error('O arquivo ZIP gerado está vazio ou corrompido.');
    }

    updateJob({ 
      status: 'completed', 
      progress: 100,
      downloadUrl: `/api/download/${uploadId}?name=${encodeURIComponent(originalName)}`,
      zipSize: zipStats.size
    });

    // Cleanup after 1 hour
    setTimeout(() => {
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        if (fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
        jobs.delete(uploadId);
      } catch (e) {
        console.error(`Job ${uploadId}: Erro na limpeza agendada:`, e);
      }
    }, 1000 * 60 * 60);

  } catch (err) {
    console.error(`Job ${uploadId}: Erro no processamento:`, err);
    jobs.set(uploadId, { 
      id: uploadId, 
      status: 'error', 
      progress: 0, 
      error: err instanceof Error ? err.message : String(err) 
    });
    
    // Cleanup on error
    setTimeout(() => {
      if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true });
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    }, 5000);
  }
}

// API: Check job status
app.get('/api/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado' });
  }
  res.json(job);
});

// New route for downloading the ZIP file
app.get('/api/download/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const fileName = req.query.name || 'video_dividido';
  const zipPath = path.join(uploadsDir, `final_${uploadId}.zip`);

  if (!fs.existsSync(zipPath)) {
    console.error(`Arquivo ZIP não encontrado: ${zipPath}`);
    return res.status(404).send('Arquivo não encontrado ou expirado.');
  }

  const zipName = `${fileName}_dividido.zip`;
  console.log(`Iniciando download do ZIP: ${zipName}`);
  res.download(zipPath, zipName, (err) => {
    if (err) {
      console.error('Erro no download do arquivo ZIP:', err);
    } else {
      console.log(`Download do ZIP ${zipName} concluído com sucesso.`);
    }
  });
});

// API: Split video (Legacy - for small files if needed, but we'll use chunked for all)
app.post('/api/split', (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Erro do Multer:', err);
      return res.status(400).json({ error: `Erro no upload: ${err.message}` });
    } else if (err) {
      console.error('Erro desconhecido no upload:', err);
      return res.status(500).json({ error: 'Erro interno no upload' });
    }
    next();
  });
}, async (req, res) => {
  console.log('Recebendo solicitação de divisão de vídeo...');
  if (!req.file) {
    console.error('Nenhum arquivo recebido');
    return res.status(400).json({ error: 'Nenhum vídeo enviado' });
  }

  console.log(`Arquivo recebido: ${req.file.originalname} (${req.file.size} bytes)`);
  const inputPath = req.file.path;
  const outputDir = path.join(uploadsDir, `split_${Date.now()}`);
  fs.mkdirSync(outputDir);

  const originalName = req.file.originalname.replace(/\.[^/.]+$/, "");
  
  try {
    console.log('Iniciando processamento FFmpeg...');
    // Split into 1-minute segments
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-f', 'segment',
          '-segment_time', '60',
          '-c', 'copy',
          '-reset_timestamps', '1'
        ])
        .output(path.join(outputDir, 'part_%d.mp4'))
        .on('start', (command) => {
          console.log('Comando FFmpeg:', command);
        })
        .on('progress', (progress) => {
          console.log(`Progresso: ${progress.percent}%`);
        })
        .on('end', () => {
          console.log('FFmpeg concluído com sucesso');
          resolve(null);
        })
        .on('error', (err) => {
          console.error('Erro FFmpeg:', err);
          reject(err);
        })
        .run();
    });

    console.log('Criando arquivo ZIP...');
    // Create ZIP
    const archive = archiver('zip', { zlib: { level: 9 } });
    const zipName = `${originalName}_dividido.zip`;
    
    res.attachment(zipName);
    archive.pipe(res);

    const files = fs.readdirSync(outputDir);
    console.log(`Encontrados ${files.length} segmentos`);
    
    if (files.length === 0) {
      throw new Error('Nenhum segmento foi gerado. Verifique se o arquivo de vídeo é válido.');
    }

    files.sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)![0]);
      const numB = parseInt(b.match(/\d+/)![0]);
      return numA - numB;
    });

    files.forEach((file, index) => {
      archive.file(path.join(outputDir, file), { name: `${index + 1}.mp4` });
    });

    await archive.finalize();
    console.log('ZIP finalizado e enviado');

    // Cleanup
    setTimeout(() => {
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          files.forEach(f => fs.unlinkSync(path.join(outputDir, f)));
          fs.rmdirSync(outputDir);
        }
        console.log('Limpeza concluída');
      } catch (e) {
        console.error('Erro na limpeza:', e);
      }
    }, 5000);

  } catch (err) {
    console.error('Erro no processamento:', err);
    res.status(500).json({ error: `Erro ao processar o vídeo: ${err instanceof Error ? err.message : String(err)}` });
    // Cleanup on error
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputDir)) {
      try {
        const files = fs.readdirSync(outputDir);
        files.forEach(f => fs.unlinkSync(path.join(outputDir, f)));
        fs.rmdirSync(outputDir);
      } catch (e) {
        console.error('Erro na limpeza pós-erro:', e);
      }
    }
  }
});

// Catch-all for unmatched API routes
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `Rota API não encontrada: ${req.method} ${req.url}` });
});

// Global error handler for JSON responses
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Erro Global:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Vite middleware for development
if (process.env.NODE_ENV !== 'production') {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

const PORT = 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Increase server timeout for large file processing (10 minutes)
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 601000;
