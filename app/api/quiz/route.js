import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export async function POST(request) {
  try {
    const { noteId } = await request.json();
    if (!noteId || typeof noteId !== 'string') {
      return Response.json({ success: false, error: '노트 정보가 올바르지 않아요.' }, { status: 400 });
    }

    const { data: note, error: noteError } = await supabase
      .from('notes')
      .select('id, status')
      .eq('id', noteId)
      .single();
    if (noteError || !note || note.status !== 'done') {
      return Response.json({ success: false, error: '분석이 완료된 노트만 퀴즈를 만들 수 있어요.' }, { status: 404 });
    }

    const { data: summary, error: summaryError } = await supabase
      .from('note_summaries')
      .select('summary, keywords')
      .eq('note_id', noteId)
      .single();
    if (summaryError || !summary) {
      return Response.json({ success: false, error: '노트 요약을 찾을 수 없어요.' }, { status: 404 });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const prompt = `다음 학습 노트를 바탕으로 한국어 객관식 복습 문제 5개를 만드세요.
요약: ${summary.summary}
핵심 키워드: ${(summary.keywords || []).join(', ')}

JSON만 출력하고 마크다운 코드 블록이나 다른 설명은 넣지 마세요. 각 문제는 서로 다른 핵심 내용을 확인하고, 선택지는 정확히 4개이며, 정답은 하나만 있어야 합니다.
형식:
{
  "questions": [
    { "question": "질문", "options": ["선택지1", "선택지2", "선택지3", "선택지4"], "answerIndex": 0, "explanation": "정답인 이유를 한 문장으로 설명" }
  ]
}`;

    const result = await model.generateContent(prompt);
    const cleaned = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const questions = parsed.questions;

    if (!Array.isArray(questions) || questions.length !== 5 || questions.some((question) =>
      typeof question.question !== 'string' ||
      !Array.isArray(question.options) || question.options.length !== 4 ||
      question.options.some((option) => typeof option !== 'string') ||
      !Number.isInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex > 3 ||
      typeof question.explanation !== 'string'
    )) {
      throw new Error('AI가 올바른 퀴즈 형식으로 응답하지 않았어요. 다시 시도해주세요.');
    }

    return Response.json({ success: true, questions });
  } catch (error) {
    return Response.json({ success: false, error: error.message || '퀴즈 생성 중 오류가 발생했어요.' }, { status: 500 });
  }
}
