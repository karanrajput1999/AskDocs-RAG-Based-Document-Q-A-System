import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChromaClient } from 'chromadb';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly embeddings: GoogleGenerativeAIEmbeddings;
  private readonly llm: ChatGoogleGenerativeAI;
  private readonly chromaClient: ChromaClient;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');

    this.embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey,
      model: 'gemini-embedding-001',
    });

    this.llm = new ChatGoogleGenerativeAI({
      apiKey,
      model: 'gemini-2.5-flash',
    });

    this.chromaClient = new ChromaClient({
      host: this.configService.get<string>('CHROMA_HOST'),
      port: this.configService.get<number>('CHROMA_PORT'),
    });
  }

  async query(question: string) {
    let start = Date.now();

    const queryEmbedding = await this.embeddings.embedQuery(question);
    this.logger.log(`Embedding query took ${Date.now() - start}ms`);

    start = Date.now();
    const collection = await this.chromaClient.getOrCreateCollection({ name: 'documents' });
    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: 5,
      include: ['documents', 'metadatas'],
    });
    this.logger.log(`ChromaDB query took ${Date.now() - start}ms`);

    const chunks = results.documents?.[0] ?? [];
    const metadatas = results.metadatas?.[0] ?? [];

    if (chunks.length === 0) {
      return {
        sources: [],
        stream: null,
        fallbackAnswer: 'No relevant documents found. Please upload a document first.',
      };
    }

    const context = chunks
      .map((chunk, i) => `[Chunk ${i + 1}]\n${chunk}`)
      .join('\n\n');

    const prompt = `Answer the question using only the provided context. Be natural and conversational — as if you've read the document yourself.

Rules:
- Never start with "Based on the provided context" or similar phrasing. Just answer directly.
- Avoid bullet-point dumps unless the user explicitly asks for a list. Prefer concise, flowing sentences.
- Summarize and highlight what stands out rather than restating every detail.
- If the answer isn't in the context, just say you couldn't find that information in the document.

Context:
${context}

Question: ${question}`;

    this.logger.log(`Querying LLM with ${chunks.length} chunks as context`);

    const sources = metadatas.map((meta, i) => ({
      chunk: chunks[i],
      ...meta,
    }));

    const stream = this.llm.stream(prompt);

    return { sources, stream };
  }
}
