import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export async function POST(request) {
  try {
    const { noteId, questions, answers } = await request.json();
    if (typeof noteId !== 'string' || !noteId || !Array.isArray(questions) || questions.length !== 5 || !answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== questions.length) {
      return Response.json({ success: false, error: '퀴즈 기록 정보가 올바르지 않아요.' }, { status: 400 });
    }
    if (questions.some((question, index) =>
      typeof question.question !== 'string' ||
      !Array.isArray(question.options) || question.options.length !== 4 ||
      !Number.isInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex >= question.options.length ||
      !Number.isInteger(answers[index]) || answers[index] < 0 || answers[index] >= question.options.length
    )) {
      return Response.json({ success: false, error: '퀴즈 정답 정보가 올바르지 않아요.' }, { status: 400 });
    }

    const { data: note, error: noteError } = await supabase
      .from('notes')
      .select('id, status')
      .eq('id', noteId)
      .single();
    if (noteError || !note || note.status !== 'done') {
      return Response.json({ success: false, error: '분석이 완료된 노트만 기록할 수 있어요.' }, { status: 404 });
    }

    const score = questions.reduce((sum, question, index) => sum + (answers[index] === question.answerIndex ? 1 : 0), 0);
    const ratio = score / questions.length;
    const intervalDays = ratio < 0.6 ? 1 : ratio < 0.8 ? 2 : ratio < 1 ? 4 : 7;
    const nextReviewAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString();
    const wrongQuestions = questions.flatMap((question, index) => answers[index] === question.answerIndex ? [] : [{
      question: question.question,
      selectedAnswer: Number.isInteger(answers[index]) ? question.options[answers[index]] : null,
      correctAnswer: question.options[question.answerIndex],
      explanation: question.explanation,
    }]);

    return Response.json({ success: true, score, total: questions.length, wrongQuestions, nextReviewAt, intervalDays });
  } catch (error) {
    return Response.json({ success: false, error: error.message || '퀴즈 결과를 저장하지 못했어요.' }, { status: 500 });
  }
}
