import React, { useState, useRef, useEffect } from 'react';
import { 
  Upload, 
  Scissors, 
  Download, 
  FileVideo, 
  CheckCircle2, 
  Loader2, 
  X, 
  AlertCircle,
  Play,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface VideoFile {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error';
  progress: number;
  parts: number;
  minutes: number;
  splitMode: 'parts' | 'minutes';
  error?: string;
  zipUrl?: string;
}

export default function App() {
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [globalParts, setGlobalParts] = useState(2);
  const [globalMinutes, setGlobalMinutes] = useState(1);
  const [globalSplitMode, setGlobalSplitMode] = useState<'parts' | 'minutes'>('parts');
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [showSafariHelp, setShowSafariHelp] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  // Check connection and cookies on mount and periodically if error exists
  const checkConnection = async (isRetry = false) => {
    if (!isRetry) setIsChecking(true);
    try {
      console.log('Verificando conexão com o servidor...');
      const res = await fetch('/api/health');
      const contentType = res.headers.get('content-type');
      
      if (res.ok && contentType && contentType.includes('application/json')) {
        console.log('Conexão com o servidor OK');
        setCookieError(null);
        return true;
      }

      const text = await res.text();
      console.warn('Resposta de saúde inesperada:', res.status);
      
      if (text.includes('Cookie check') || text.includes('Action required')) {
        setCookieError('O seu navegador está bloqueando cookies de segurança. Isso é comum no Safari/iPhone e impede o processamento de vídeos.');
      } else if (res.status >= 500) {
        console.log('Servidor possivelmente iniciando...');
      }
      return false;
    } catch (err) {
      console.error('Erro ao verificar conexão:', err);
      return false;
    } finally {
      if (!isRetry) setIsChecking(false);
    }
  };

  useEffect(() => {
    checkConnection();
    
    // Auto-retry every 5 seconds if there's an error
    const interval = setInterval(() => {
      if (cookieError) {
        checkConnection(true);
      }
    }, 5000);
    
    return () => clearInterval(interval);
  }, [cookieError]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      console.log('Evento de alteração de arquivo disparado');
      const inputFiles = e.target.files;
      
      if (inputFiles && inputFiles.length > 0) {
        const files = Array.from(inputFiles) as File[];
        console.log(`Arquivos detectados no input: ${files.length}`, files.map(f => f.name));
        
        const newFiles = files.map(file => ({
          id: Math.random().toString(36).substring(7) + Date.now(),
          file,
          status: 'pending' as const,
          progress: 0,
          parts: globalParts,
          minutes: globalMinutes,
          splitMode: globalSplitMode,
        }));
        
        console.log('Criando novos objetos de arquivo:', newFiles.length);
        
        setVideoFiles(prev => {
          const updated = [...prev, ...newFiles];
          console.log(`Estado videoFiles atualizado. Total: ${updated.length}`);
          return updated;
        });
        
        // Reset input para permitir selecionar o mesmo arquivo novamente
        e.target.value = '';
      } else {
        console.warn('Nenhum arquivo encontrado no evento de alteração');
      }
    } catch (err) {
      console.error('Erro crítico no handleFileChange:', err);
      alert('Erro ao selecionar arquivo. Por favor, tente novamente ou use outro navegador.');
    }
  };

  const removeFile = (id: string) => {
    setVideoFiles(prev => prev.filter(f => f.id !== id));
  };

  const splitVideo = async (videoFile: VideoFile) => {
    const { file, id } = videoFile;
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = `${Date.now()}-${id}`;

    setVideoFiles(prev => prev.map(f => 
      f.id === id ? { ...f, status: 'uploading', progress: 0 } : f
    ));

    try {
      // 1. Upload Chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', i.toString());

        let retries = 3;
        let success = false;
        while (retries > 0 && !success) {
          try {
            const response = await fetch('/api/upload-chunk', {
              method: 'POST',
              body: formData,
            });

            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Erro do servidor no chunk ${i + 1}: ${text.substring(0, 50)}`);
            }
            success = true;
          } catch (err) {
            retries--;
            console.warn(`Falha no chunk ${i}, tentativas restantes: ${retries}`, err);
            if (retries === 0) throw err;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
          }
        }

        const progress = Math.round(((i + 1) / totalChunks) * 100);
        setVideoFiles(prev => prev.map(f => 
          f.id === id ? { ...f, progress } : f
        ));
      }

      // 2. Finalize and Process
      setVideoFiles(prev => prev.map(f => 
        f.id === id ? { ...f, status: 'processing' } : f
      ));

      const finalizeResponse = await fetch('/api/finalize-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          fileName: file.name,
          totalChunks,
          parts: videoFile.parts,
          minutes: videoFile.minutes,
          splitMode: videoFile.splitMode
        }),
      });

      console.log('Resposta de finalização recebida:', finalizeResponse.status, finalizeResponse.ok);
      
      if (!finalizeResponse.ok) {
        const contentType = finalizeResponse.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await finalizeResponse.json();
          throw new Error(errorData.error || 'Falha no processamento do servidor');
        } else {
          const text = await finalizeResponse.text();
          throw new Error(`Erro do servidor (${finalizeResponse.status}): ${text.substring(0, 100)}`);
        }
      }

      const contentType = finalizeResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await finalizeResponse.text();
        if (text.includes('Cookie check') || text.includes('Action required to load your app')) {
          throw new Error('O navegador bloqueou cookies de segurança. Por favor, abra o app em uma nova aba (botão no topo) ou desative "Impedir Rastreamento Entre Sites" nas configurações do Safari/iOS.');
        }
        console.error('Resposta não-JSON recebida:', text);
        throw new Error('O servidor retornou uma resposta inválida (não-JSON). Verifique os logs do servidor.');
      }

      const result = await finalizeResponse.json();
      const jobId = result.jobId;
      console.log('Job iniciado:', jobId);

      // 3. Poll for job status
      let jobCompleted = false;
      let pollCount = 0;
      const maxPolls = 600; // 20 minutes max

      while (!jobCompleted && pollCount < maxPolls) {
        pollCount++;
        await new Promise(r => setTimeout(r, 3000));
        
        try {
          const statusRes = await fetch(`/api/job-status/${jobId}`);
          if (!statusRes.ok) {
            const statusText = await statusRes.text();
            if (statusText.includes('Cookie check')) {
               throw new Error('Sessão expirada ou cookies bloqueados. Por favor, abra em uma nova aba.');
            }
            throw new Error(`Falha ao verificar status: ${statusRes.status}`);
          }
          
          const job = await statusRes.json();
          if (job.status === 'completed') {
            jobCompleted = true;
            setVideoFiles(prev => prev.map(f => 
              f.id === id ? { ...f, status: 'completed', zipUrl: job.downloadUrl } : f
            ));

            // Automatically trigger download
            const a = document.createElement('a');
            a.href = job.downloadUrl;
            a.download = `${file.name.replace(/\.[^/.]+$/, "")}_dividido.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } else if (job.status === 'error') {
            throw new Error(job.error || 'Erro no processamento do vídeo');
          } else {
            // Update progress based on job progress
            setVideoFiles(prev => prev.map(f => 
              f.id === id ? { ...f, progress: job.progress } : f
            ));
          }
        } catch (pollErr) {
          console.error('Erro no polling:', pollErr);
          if (pollErr instanceof Error && pollErr.message.includes('cookies')) {
            throw pollErr;
          }
          // Continue polling on transient errors
        }
      }

      if (!jobCompleted) {
        throw new Error('O processamento demorou muito tempo. Verifique se o vídeo foi processado corretamente.');
      }
    } catch (err) {
      console.error(err);
      setVideoFiles(prev => prev.map(f => 
        f.id === id ? { ...f, status: 'error', error: err instanceof Error ? err.message : 'Erro ao processar vídeo' } : f
      ));
    }
  };

  const processAll = async () => {
    setIsProcessingAll(true);
    const pending = videoFiles.filter(f => f.status === 'pending');
    for (const file of pending) {
      await splitVideo(file);
    }
    setIsProcessingAll(false);
  };

  const downloadZip = (videoFile: VideoFile) => {
    if (!videoFile.zipUrl) return;
    const a = document.createElement('a');
    a.href = videoFile.zipUrl;
    a.download = `${videoFile.file.name.replace(/\.[^/.]+$/, "")}_dividido.zip`;
    a.click();
  };

  const clearAll = () => {
    setVideoFiles([]);
    setIsProcessingAll(false);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Cookie Warning Banner */}
      <AnimatePresence>
        {cookieError && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-orange-600 text-white overflow-hidden shadow-2xl relative z-[100]"
          >
            <div className="max-w-4xl mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center animate-pulse">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div>
                  <p className="font-bold text-lg">Ação Necessária</p>
                  <p className="text-sm opacity-90">{cookieError}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button 
                  onClick={() => window.open(window.location.href, '_blank')}
                  className="bg-white text-orange-600 px-6 py-2 rounded-xl text-sm font-bold hover:bg-orange-50 transition-all shadow-lg flex items-center gap-2 active:scale-95"
                >
                  <ExternalLink className="w-4 h-4" />
                  ABRIR EM NOVA ABA (RESOLVE O ERRO)
                </button>
                <button 
                  onClick={() => checkConnection()}
                  disabled={isChecking}
                  className="bg-white/20 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-white/30 transition-all flex items-center gap-2"
                >
                  <Loader2 className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
                  Tentar Novamente
                </button>
                <button 
                  onClick={() => setCookieError(null)}
                  className="bg-black/20 text-white/70 px-4 py-2 rounded-xl text-sm font-medium hover:bg-black/30 transition-all"
                >
                  Ignorar
                </button>
                <button 
                  onClick={() => setShowSafariHelp(true)}
                  className="bg-white/10 text-white border border-white/20 px-4 py-2 rounded-xl text-sm font-medium hover:bg-white/20 transition-all"
                >
                  Como configurar o Safari
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Safari Help Modal */}
      <AnimatePresence>
        {showSafariHelp && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSafariHelp(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl"
            >
              <button 
                onClick={() => setShowSafariHelp(false)}
                className="absolute top-4 right-4 p-2 hover:bg-white/5 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
              <h3 className="text-2xl font-bold mb-6 flex items-center gap-2">
                <Scissors className="w-6 h-6 text-orange-500" />
                Configurações do Safari
              </h3>
              <div className="space-y-6 text-gray-300">
                <div className="space-y-2">
                  <p className="font-semibold text-white">No iPhone/iPad:</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Abra os <span className="text-white">Ajustes</span></li>
                    <li>Vá em <span className="text-white">Safari</span></li>
                    <li>Desative <span className="text-orange-400">"Impedir Rastreamento Entre Sites"</span></li>
                  </ol>
                </div>
                <div className="space-y-2">
                  <p className="font-semibold text-white">No Mac:</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>Abra o <span className="text-white">Safari</span></li>
                    <li>Vá em <span className="text-white">Ajustes...</span> (ou Preferências)</li>
                    <li>Clique na aba <span className="text-white">Privacidade</span></li>
                    <li>Desmarque <span className="text-orange-400">"Impedir Rastreamento Entre Sites"</span></li>
                  </ol>
                </div>
                <div className="pt-4 border-t border-white/5">
                  <p className="text-xs text-gray-500 italic">
                    Nota: Esta é uma restrição de segurança do navegador para aplicativos rodando dentro de outros sites (iframes).
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Open in new tab button */}
      <div className="fixed top-6 right-6 z-50">
        <button 
          onClick={() => window.open(window.location.href, '_blank')}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 backdrop-blur-md border border-white/10 hover:bg-white/10 transition-all text-sm font-medium group"
        >
          <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-white transition-colors" />
          <span className="text-gray-400 group-hover:text-white transition-colors">Abrir em nova aba</span>
        </button>
      </div>

      {/* Background Glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-orange-500/10 blur-[120px] rounded-full" />
        <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
      </div>

      <main className="relative max-w-4xl mx-auto px-6 py-12">
        <header className="mb-12 text-center">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-500 text-xs font-semibold mb-4"
          >
            <Scissors className="w-3 h-3" />
            VIDEO SPLITTER PRO (NATIVO)
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl font-bold tracking-tight mb-4"
          >
            Divida seus vídeos em <span className="text-orange-500 italic">segundos.</span>
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-gray-400 text-lg max-w-xl mx-auto"
          >
            Envie seus vídeos e escolha em quantas partes deseja dividi-los. 
            Processamento nativo e ultra rápido.
          </motion.p>
        </header>

        <div className="space-y-8">
          {/* Global Settings */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 space-y-6"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                  <Scissors className="w-5 h-5 text-orange-500" />
                </div>
                <div>
                  <h3 className="font-semibold">Configuração de Divisão</h3>
                  <p className="text-xs text-gray-500">Escolha como deseja dividir seus vídeos</p>
                </div>
              </div>

              <div className="flex bg-black/40 p-1 rounded-lg border border-white/5">
                <button
                  onClick={() => setGlobalSplitMode('parts')}
                  className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
                    globalSplitMode === 'parts' 
                    ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20' 
                    : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Por Partes
                </button>
                <button
                  onClick={() => setGlobalSplitMode('minutes')}
                  className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
                    globalSplitMode === 'minutes' 
                    ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20' 
                    : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Por Tempo
                </button>
              </div>
            </div>

            {/* Server Status Indicator */}
            <div className="flex justify-center">
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase border ${
                cookieError ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-green-500/10 border-green-500/20 text-green-400'
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full ${cookieError ? 'bg-red-500 animate-pulse' : 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'}`} />
                {cookieError ? 'Servidor Desconectado' : 'Servidor Conectado'}
              </div>
            </div>
            
            <div className="flex items-center gap-4 bg-black/20 p-4 rounded-xl border border-white/5 justify-center">
              {globalSplitMode === 'parts' ? (
                <>
                  <span className="text-sm text-gray-400">Dividir cada vídeo em:</span>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setGlobalParts(Math.max(1, globalParts - 1))}
                      className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-xl transition-colors border border-white/5"
                    >
                      -
                    </button>
                    <input 
                      type="number" 
                      value={globalParts}
                      onChange={(e) => setGlobalParts(parseInt(e.target.value) || 1)}
                      className="w-16 text-center bg-transparent font-bold text-2xl text-orange-500 focus:outline-none"
                    />
                    <button 
                      onClick={() => setGlobalParts(globalParts + 1)}
                      className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-xl transition-colors border border-white/5"
                    >
                      +
                    </button>
                  </div>
                  <span className="text-sm text-gray-400 font-medium">PARTES IGUAIS</span>
                </>
              ) : (
                <>
                  <span className="text-sm text-gray-400">Dividir a cada:</span>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setGlobalMinutes(Math.max(0.1, globalMinutes - 0.5))}
                      className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-xl transition-colors border border-white/5"
                    >
                      -
                    </button>
                    <input 
                      type="number" 
                      step="0.5"
                      value={globalMinutes}
                      onChange={(e) => setGlobalMinutes(parseFloat(e.target.value) || 1)}
                      className="w-20 text-center bg-transparent font-bold text-2xl text-orange-500 focus:outline-none"
                    />
                    <button 
                      onClick={() => setGlobalMinutes(globalMinutes + 0.5)}
                      className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-xl transition-colors border border-white/5"
                    >
                      +
                    </button>
                  </div>
                  <span className="text-sm text-gray-400 font-medium">MINUTOS</span>
                </>
              )}
            </div>
          </motion.div>
          {/* Upload Zone */}
          <div className="relative group">
            <input 
              type="file" 
              onChange={handleFileChange}
              multiple 
              accept="video/*" 
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" 
              title="Clique para selecionar vídeos"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="group relative"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-orange-500/20 to-blue-500/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              <div className="relative border-2 border-dashed border-white/10 rounded-3xl p-12 flex flex-col items-center justify-center gap-4 bg-white/[0.02] backdrop-blur-sm group-hover:border-orange-500/50 transition-colors">
                <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Upload className="w-8 h-8 text-orange-500" />
                </div>
                <div className="text-center">
                  <p className="text-xl font-medium">Clique para selecionar vídeos</p>
                  <p className="text-gray-500 mt-1">MP4, MOV, AVI suportados</p>
                </div>
              </div>
            </motion.div>
          </div>

          {/* File List */}
          <AnimatePresence mode="popLayout">
            {videoFiles.length > 0 && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-lg font-semibold text-gray-300">Arquivos Selecionados ({videoFiles.length})</h2>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={clearAll}
                      disabled={isProcessingAll}
                      className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                    >
                      Limpar Tudo
                    </button>
                    {videoFiles.some(f => f.status === 'pending') && (
                      <button 
                        onClick={processAll}
                        disabled={isProcessingAll}
                        className="flex items-center gap-2 px-6 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white rounded-xl font-medium transition-all shadow-lg shadow-orange-500/20"
                      >
                        {isProcessingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        Processar Tudo
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid gap-3">
                  {videoFiles.map((vf) => (
                    <motion.div
                      key={vf.id}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      className="group relative bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex items-center gap-4 hover:bg-white/[0.05] transition-colors"
                    >
                      <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center shrink-0">
                        <FileVideo className="w-6 h-6 text-orange-500" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{vf.file.name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-xs text-gray-500">{(vf.file.size / (1024 * 1024)).toFixed(2)} MB</p>
                          <span className="text-gray-700">•</span>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-400">
                              {vf.splitMode === 'parts' ? `Dividir em ${vf.parts} partes` : `Dividir a cada ${vf.minutes} min`}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {vf.status === 'uploading' && (
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex items-center gap-2 text-orange-400 text-sm">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Enviando... {vf.progress}%</span>
                            </div>
                            <div className="w-24 h-1 bg-white/10 rounded-full overflow-hidden">
                              <motion.div 
                                className="h-full bg-orange-500"
                                initial={{ width: 0 }}
                                animate={{ width: `${vf.progress}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {vf.status === 'processing' && (
                          <div className="flex items-center gap-2 text-blue-400 text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Processando no Servidor...</span>
                          </div>
                        )}
                        
                        {vf.status === 'completed' && (
                          <div className="flex items-center gap-3">
                            <span className="text-green-500 text-sm flex items-center gap-1">
                              <CheckCircle2 className="w-4 h-4" />
                              Concluído
                            </span>
                            <button 
                              onClick={() => downloadZip(vf)}
                              className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-white transition-colors"
                              title="Baixar ZIP"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          </div>
                        )}

                        {vf.status === 'error' && (
                          <div className="text-red-500 flex flex-col items-end gap-1 text-sm">
                            <div className="flex items-center gap-1">
                              <AlertCircle className="w-4 h-4" />
                              <span>Erro</span>
                            </div>
                            {vf.error && (
                              <span 
                                className="text-[10px] text-red-400/70 max-w-[150px] text-right truncate" 
                                title={vf.error}
                              >
                                {vf.error}
                              </span>
                            )}
                          </div>
                        )}

                        {vf.status === 'pending' && (
                          <button 
                            onClick={() => splitVideo(vf)}
                            className="p-2 bg-orange-500/10 hover:bg-orange-500/20 text-orange-500 rounded-lg transition-colors"
                            title="Processar este vídeo"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                        )}

                        <button 
                          onClick={() => removeFile(vf.id)}
                          className="p-2 text-gray-500 hover:text-white transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="mt-auto py-12 text-center text-gray-600 text-sm">
        <p>© 2026 Video Splitter Pro. Processamento nativo e seguro.</p>
      </footer>
    </div>
  );
}
