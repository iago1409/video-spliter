# Video Splitter Pro — Contexto Completo

## O que é?

**Video Splitter Pro** é uma aplicação web que permite dividir vídeos longos em segmentos menores diretamente no navegador — sem precisar instalar nenhum software no computador. Basta acessar, fazer upload do vídeo, escolher como quer dividir, e baixar o ZIP com todas as partes prontas.

---

## O que o aplicativo faz (funcionalidades)

### 1. Upload de Vídeos
- Suporta arquivos de vídeo de **até 2 GB**.
- Formatos aceitos: **MP4, MOV, AVI** e outros formatos de vídeo comuns.
- Upload inteligente em **chunks de 5 MB** com sistema de **retry automático** (3 tentativas por chunk), garantindo que uploads grandes não falhem por instabilidade de conexão.
- Suporte a **múltiplos vídeos simultâneos** — selecione quantos quiser de uma vez.

### 2. Dois Modos de Divisão
- **Por Partes**: Escolha em quantas partes iguais o vídeo será dividido (ex: dividir em 3 partes).
- **Por Tempo**: Escolha o intervalo de tempo para cada segmento (ex: dividir a cada 1 minuto, 2.5 minutos, etc.).

### 3. Processamento Nativo com FFmpeg
- O vídeo é processado no servidor usando **FFmpeg** — a ferramenta profissional padrão da indústria para manipulação de vídeo.
- O corte é feito por **cópia de stream** (`-c copy`), ou seja: **sem re-encodar**, o que significa velocidade máxima e zero perda de qualidade.
- `ffprobe` é usado para validar o vídeo e detectar a duração antes do processamento.

### 4. Download Automático em ZIP
- Todos os segmentos são empacotados em um **arquivo ZIP**.
- Os arquivos dentro do ZIP são nomeados sequencialmente: `1.mp4`, `2.mp4`, `3.mp4`...
- O download é **disparado automaticamente** quando o processamento termina.
- Também é possível baixar manualmente clicando no botão de download.

### 5. Sistema de Jobs em Background
- O processamento pesado roda em **background no servidor**.
- O frontend faz **polling a cada 3 segundos** para acompanhar o progresso.
- Barra de progresso visual mostra cada etapa: upload → processamento → concluído.
- Timeout máximo de **20 minutos** de polling.

### 6. Interface Moderna e Responsiva
- Design **dark mode** com tema preto/laranja.
- Animações suaves com **Motion** (Framer Motion).
- Ícones via **Lucide React**.
- Estilização com **Tailwind CSS 4**.
- Feedback visual completo: estados de pending, uploading, processing, completed e error.
- Compatibilidade com **Safari/iOS** (tratamento de cookies de segurança).

---

## Stack Tecnológica

| Camada     | Tecnologia                                    |
|------------|-----------------------------------------------|
| Frontend   | React 19, TypeScript, Tailwind CSS 4, Motion  |
| Backend    | Express.js, Node.js, TypeScript               |
| Vídeo      | FFmpeg (fluent-ffmpeg), ffprobe                |
| Upload     | Multer (chunked upload)                        |
| Compressão | Archiver (ZIP)                                 |
| Build      | Vite                                           |
| Runtime    | tsx (TypeScript execution)                     |

---

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│                   NAVEGADOR                     │
│                                                 │
│  React App (Vite + Tailwind + Motion)           │
│  - Upload de vídeos em chunks de 5MB            │
│  - Seleção do modo de divisão                   │
│  - Polling de status do job                     │
│  - Download automático do ZIP                   │
└──────────────────┬──────────────────────────────┘
                   │ HTTP (fetch)
                   ▼
┌─────────────────────────────────────────────────┐
│               SERVIDOR EXPRESS                  │
│                                                 │
│  POST /api/upload-chunk    → Recebe chunks      │
│  POST /api/finalize-upload → Inicia job         │
│  GET  /api/job-status/:id  → Status do job      │
│  GET  /api/download/:id    → Baixa o ZIP        │
│  GET  /api/health          → Health check       │
│                                                 │
│  FFmpeg: divide o vídeo em segmentos            │
│  Archiver: empacota tudo em ZIP                 │
│  Limpeza automática após 1 hora                 │
└─────────────────────────────────────────────────┘
```

---

## Fluxo do Usuário

1. Acessa a aplicação no navegador.
2. Clica na área de upload e seleciona um ou mais vídeos.
3. Configura o modo de divisão (por partes ou por tempo).
4. Clica em **"Processar Tudo"** (ou no botão play individual).
5. Acompanha o progresso em tempo real (upload → processamento).
6. O ZIP com os segmentos é **baixado automaticamente**.

---

## Origem

Aplicação criada via **Google AI Studio** (Google Play Studios) e disponibilizada como projeto web completo com frontend e backend integrados.

---

## Como Rodar Localmente

```bash
npm install
npm run dev
```

O app estará disponível em `http://localhost:3000`.

**Pré-requisitos:** Node.js instalado na máquina.
