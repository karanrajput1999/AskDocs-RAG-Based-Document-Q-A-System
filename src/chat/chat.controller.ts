import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async query(@Body('question') question: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = await this.chatService.query(question);

    // Send sources first
    res.write(`data: ${JSON.stringify({ type: 'sources', sources: result.sources })}\n\n`);

    if (!result.stream) {
      if (result.fallbackAnswer) {
        res.write(`data: ${JSON.stringify({ type: 'token', token: result.fallbackAnswer })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
      res.end();
      return;
    }

    const stream = await result.stream;

    // Stream answer tokens
    for await (const chunk of stream) {
      const text =
        typeof chunk.content === 'string'
          ? chunk.content
          : '';
      if (text) {
        res.write(`data: ${JSON.stringify({ type: 'token', token: text })}\n\n`);
      }
    }

    // Signal end of stream
    res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
    res.end();
  }
}
