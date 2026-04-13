import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { Document } from '@langchain/core/documents';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { ChromaClient } from 'chromadb';

const MIN_TOKEN_COUNT = 200;

export enum DocumentStatus {
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly statusStore = new Map<string, DocumentStatus>();
  private readonly textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  private readonly embeddings: GoogleGenerativeAIEmbeddings;
  private readonly chromaClient: ChromaClient;

  constructor(private readonly configService: ConfigService) {
    this.embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: this.configService.get<string>('GEMINI_API_KEY'),
      model: 'gemini-embedding-001',
    });
    this.chromaClient = new ChromaClient({
      host: this.configService.get<string>('CHROMA_HOST'),
      port: this.configService.get<number>('CHROMA_PORT'),
    });
  }

  async handleFileUpload(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const documents = await this.loadDocuments(file);
    const text = documents.map((doc) => doc.pageContent).join('\n');
    const estimatedTokens = Math.ceil(text.split(/\s+/).length / 0.75);

    if (estimatedTokens < MIN_TOKEN_COUNT) {
      throw new BadRequestException(
        `Document has too few tokens (~${estimatedTokens}). Minimum required: ${MIN_TOKEN_COUNT}.`,
      );
    }

    const documentId = randomUUID();
    this.statusStore.set(documentId, DocumentStatus.PROCESSING);

    this.processDocument(documentId, documents, file.originalname);

    return {
      documentId,
      status: DocumentStatus.PROCESSING,
      file: {
        originalName: file.originalname,
        filename: file.filename,
        size: file.size,
        mimetype: file.mimetype,
      },
    };
  }

  getStatus(documentId: string) {
    const status = this.statusStore.get(documentId);
    if (!status) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }
    return { documentId, status };
  }

  private async processDocument(documentId: string, documents: Document[], originalName: string) {
    try {
      const allChunks = await this.textSplitter.splitDocuments(documents);
      // Drop chunks that are empty or whitespace-only — the embedder returns an
      // empty vector for them, which ChromaDB rejects.
      const chunks = allChunks.filter((chunk) => chunk.pageContent.trim().length > 0);
      this.logger.log(
        `Processed "${originalName}": ${documents.length} document(s) → ${chunks.length} chunk(s)` +
          (allChunks.length !== chunks.length
            ? ` (dropped ${allChunks.length - chunks.length} empty)`
            : ''),
      );

      if (chunks.length === 0) {
        throw new Error('No non-empty chunks produced from document');
      }

      const chunkTexts = chunks.map((chunk) => chunk.pageContent);
      const rawVectors = await this.embeddings.embedDocuments(chunkTexts);

      // Also guard against the embedder returning an empty vector for a chunk
      // (can happen with unusual characters / PDF artifacts).
      const validIndices: number[] = [];
      rawVectors.forEach((vec, i) => {
        if (Array.isArray(vec) && vec.length > 0) validIndices.push(i);
      });
      const vectors = validIndices.map((i) => rawVectors[i]);
      const validTexts = validIndices.map((i) => chunkTexts[i]);
      const validChunks = validIndices.map((i) => chunks[i]);

      if (vectors.length !== rawVectors.length) {
        this.logger.warn(
          `Dropped ${rawVectors.length - vectors.length} chunk(s) with empty embeddings for "${originalName}"`,
        );
      }

      if (vectors.length === 0) {
        throw new Error('All embeddings were empty');
      }

      this.logger.log(
        `Generated ${vectors.length} embeddings (dimension: ${vectors[0].length}) for "${originalName}"`,
      );

      const collection = await this.chromaClient.getOrCreateCollection({ name: 'documents' });
      await collection.add({
        ids: validChunks.map((_, i) => `${documentId}-chunk-${i}`),
        embeddings: vectors,
        documents: validTexts,
        metadatas: validChunks.map((chunk, i) => {
          const filtered: Record<string, string | number | boolean> = {
            documentId,
            originalName,
            chunkIndex: i,
          };
          for (const [key, value] of Object.entries(chunk.metadata)) {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              filtered[key] = value;
            }
          }
          return filtered;
        }),
      });

      this.logger.log(
        `Stored ${vectors.length} vectors in ChromaDB for "${originalName}"`,
      );

      this.statusStore.set(documentId, DocumentStatus.READY);
    } catch (error) {
      this.logger.error(`Failed to process "${originalName}": ${error}`);
      this.statusStore.set(documentId, DocumentStatus.FAILED);
    }
  }

  async getCollectionData() {
    const collection = await this.chromaClient.getOrCreateCollection({ name: 'documents' });
    return collection.get({ include: ['documents', 'metadatas'] });
  }

  private async loadDocuments(file: Express.Multer.File) {
    const ext = extname(file.originalname).toLowerCase();

    switch (ext) {
      case '.pdf':
        return new PDFLoader(file.path).load();
      case '.docx':
        return new DocxLoader(file.path).load();
      case '.txt': {
        const content = await readFile(file.path, 'utf-8');
        return [new Document({ pageContent: content, metadata: { source: file.path } })];
      }
      default:
        throw new BadRequestException(`Unsupported file type: ${ext}`);
    }
  }
}
