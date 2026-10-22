import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export async function POST(request) {
  let noteId;

  try {
    ({ noteId } = await request.json());
    if (typeof noteId !== 'string' || !noteId) {
      return Response.json({ success: false, error: '노트 정보가 올바르지 않아요.' }, { status: 400 });
    }

    const { data: note, error: noteError } = await supabase
      .from('notes')
      .select('id, image_url')
      .eq('id', noteId)
      .single();
    if (noteError || !note) throw new Error('분석할 노트를 찾을 수 없어요.');

    const { error: pendingError } = await supabase
      .from('notes')
      .update({ status: 'pending', error_message: null })
      .eq('id', noteId);
    if (pendingError) throw pendingError;

    const imageResponse = await fetch(note.image_url);
    if (!imageResponse.ok) throw new Error('노트 사진을 불러오지 못했어요.');
    const mimeType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      throw new Error('JPG, PNG, WEBP 형식의 사진만 분석할 수 있어요.');
    }
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const prompt = `이 이미지는 학생의 학습 노트 사진입니다.
다음 형식의 JSON으로만 답하세요 (다른 설명 없이):
{
  "summary": "노트 내용을 3~4문장으로 요약",
  "keywords": ["핵심 키워드1", "핵심 키워드2", "핵심 키워드3"]
}`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Image, mimeType } },
    ]);
    const cleaned = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.keywords)) {
      throw new Error('AI가 요약을 올바른 형식으로 만들지 못했어요. 다시 시도해주세요.');
    }

    const { data: existingSummary, error: summaryLookupError } = await supabase
      .from('note_summaries')
      .select('id')
      .eq('note_id', noteId)
      .limit(1)
      .maybeSingle();
    if (summaryLookupError) throw summaryLookupError;

    const summaryMutation = existingSummary
      ? supabase.from('note_summaries').update({ summary: parsed.summary, keywords: parsed.keywords }).eq('id', existingSummary.id)
      : supabase.from('note_summaries').insert({ note_id: noteId, summary: parsed.summary, keywords: parsed.keywords });
    const { error: summaryError } = await summaryMutation;
    if (summaryError) throw summaryError;

    const { error: doneError } = await supabase
      .from('notes')
      .update({ status: 'done', error_message: null })
      .eq('id', noteId);
    if (doneError) throw doneError;

    return Response.json({ success: true, summary: parsed.summary, keywords: parsed.keywords });
  } catch (error) {
    if (noteId) {
      await supabase.from('notes').update({ status: 'failed', error_message: error.message }).eq('id', noteId);
    }
    return Response.json({ success: false, error: error.message || '노트 분석 중 오류가 발생했어요.' }, { status: 500 });
  }
}
