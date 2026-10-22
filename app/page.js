'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const filters = [
  ['all', '전체'],
  ['due', '복습할 노트'],
  ['done', '완료'],
  ['failed', '실패'],
];
const ATTEMPTS_STORAGE_KEY = 'study-note-ai:quiz-attempts';
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

function mergeImageFiles(existing, incoming) {
  const known = new Set(existing.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
  return [...existing, ...Array.from(incoming).filter((file) => {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!imageTypes.includes(file.type) || known.has(key)) return false;
    known.add(key);
    return true;
  })];
}

const formatDate = (value, options = { year: 'numeric', month: 'long', day: 'numeric' }) =>
  value ? new Date(value).toLocaleDateString('ko-KR', options) : '날짜 없음';

export default function Home() {
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [message, setMessage] = useState('');
  const [notes, setNotes] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [quizLoadingId, setQuizLoadingId] = useState(null);
  const [quizSaving, setQuizSaving] = useState(false);
  const [quizError, setQuizError] = useState('');
  const [quizSaveError, setQuizSaveError] = useState('');
  const [activeQuiz, setActiveQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [showResults, setShowResults] = useState(false);
  const [attemptResult, setAttemptResult] = useState(null);
  const [metadataEditingId, setMetadataEditingId] = useState(null);
  const [metadataDraft, setMetadataDraft] = useState({ title: '', subject: '', tags: '' });
  const [summaryEditingId, setSummaryEditingId] = useState(null);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [keywordsDraft, setKeywordsDraft] = useState('');

  async function loadNotes() {
    setLoadingNotes(true);
    const { data, error } = await supabase.from('notes').select('*, note_summaries(id, summary, keywords)').order('created_at', { ascending: false });
    if (!error) setNotes(data || []);
    else setMessage(`기록을 불러오지 못했어요: ${error.message}`);
    setLoadingNotes(false);
  }

  useEffect(() => {
    loadNotes();
    try {
      const savedAttempts = window.localStorage.getItem(ATTEMPTS_STORAGE_KEY);
      if (savedAttempts) {
        const parsedAttempts = JSON.parse(savedAttempts);
        if (Array.isArray(parsedAttempts)) setAttempts(parsedAttempts);
      }
    } catch {
      setQuizSaveError('이 브라우저에서 저장된 퀴즈 기록을 읽지 못했어요.');
    }
  }, []);

  useEffect(() => {
    function handlePaste(event) {
      const pastedImages = Array.from(event.clipboardData?.items || [])
        .filter((item) => imageTypes.includes(item.type))
        .map((item, index) => {
          const blob = item.getAsFile();
          if (!blob) return null;
          const extension = blob.type.split('/')[1] === 'jpeg' ? 'jpg' : blob.type.split('/')[1];
          return new File([blob], `clipboard-${Date.now()}-${index}.${extension}`, { type: blob.type, lastModified: Date.now() });
        }).filter(Boolean);
      if (!pastedImages.length) return;
      event.preventDefault();
      setFiles((current) => mergeImageFiles(current, pastedImages));
      setMessage(`${pastedImages.length}장의 클립보드 이미지를 대기열에 추가했어요.`);
    }
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  const latestAttempts = useMemo(() => attempts.reduce((result, attempt) => {
    if (!result[attempt.note_id]) result[attempt.note_id] = [];
    result[attempt.note_id].push(attempt);
    return result;
  }, {}), [attempts]);

  const dueNotes = useMemo(() => notes.filter((note) =>
    note.status === 'done' && latestAttempts[note.id]?.[0]?.next_review_at && new Date(latestAttempts[note.id][0].next_review_at).getTime() <= Date.now()
  ), [notes, latestAttempts]);

  const filteredNotes = useMemo(() => notes.filter((note) => {
    const summary = note.note_summaries?.[0];
    const haystack = [note.title, note.subject, ...(note.tags || []), summary?.summary, ...(summary?.keywords || [])]
      .filter(Boolean).join(' ').toLowerCase();
    const matchesFilter = filter === 'all' ||
      (filter === 'due' ? dueNotes.some((dueNote) => dueNote.id === note.id) : note.status === filter);
    return matchesFilter && haystack.includes(query.trim().toLowerCase());
  }), [notes, query, filter, dueNotes]);

  const completedCount = notes.filter((note) => note.status === 'done').length;
  async function analyzeNote(noteId) {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '분석에 실패했어요.');
  }

  async function handleUpload() {
    if (!files.length || busy) return;
    setBusy(true);
    const queue = [...files];
    const failures = [];
    let completed = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const file = queue[index];
      try {
        setUploadProgress({ completed, total: queue.length, name: file.name, phase: '사진 업로드 중' });
        const fileName = `${Date.now()}-${index}-${file.name.replace(/[^\w.-]/g, '_')}`;
        const { error: uploadError } = await supabase.storage.from('note-images').upload(fileName, file);
        if (uploadError) throw uploadError;
        const { data: urlData } = supabase.storage.from('note-images').getPublicUrl(fileName);
        const tags = tagInput.split(',').map((tag) => tag.trim()).filter(Boolean);
        const noteTitle = title.trim()
          ? (queue.length > 1 ? `${title.trim()} ${index + 1}` : title.trim())
          : file.name.replace(/\.[^.]+$/, '');
        const { data: note, error: insertError } = await supabase.from('notes').insert({
          image_url: urlData.publicUrl,
          status: 'pending',
          title: noteTitle,
          subject: subject.trim(),
          tags,
        }).select().single();
        if (insertError) throw insertError;
        setUploadProgress({ completed, total: queue.length, name: file.name, phase: 'AI가 노트를 분석 중' });
        await analyzeNote(note.id);
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
      completed += 1;
      setUploadProgress({ completed, total: queue.length, name: file.name, phase: '처리 완료' });
    }
    const successful = queue.length - failures.length;
    setMessage(failures.length
      ? `${successful}장 완료, ${failures.length}장 실패: ${failures.slice(0, 2).join(' · ')}`
      : `${successful}장의 노트 정리가 끝났어요. 복습 퀴즈도 풀어보세요!`);
    setFiles([]);
    setTitle(''); setSubject(''); setTagInput('');
    const input = document.getElementById('note-file');
    if (input) input.value = '';
    setBusy(false);
    setUploadProgress(null);
    await loadNotes();
  }

  async function retryAnalysis(noteId) {
    setRetryingId(noteId); setMessage('노트를 다시 분석하고 있어요…');
    try {
      await analyzeNote(noteId);
      setMessage('노트 분석을 다시 완료했어요.');
    } catch (error) {
      setMessage(`다시 분석하지 못했어요: ${error.message}`);
    } finally {
      setRetryingId(null);
      await loadNotes();
    }
  }

  async function createQuiz(noteId) {
    setQuizLoadingId(noteId); setQuizError(''); setQuizSaveError('');
    setActiveQuiz(null); setAnswers({}); setShowResults(false); setAttemptResult(null);
    try {
      const response = await fetch('/api/quiz', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noteId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '퀴즈를 만들지 못했어요.');
      setActiveQuiz({ noteId, questions: data.questions });
    } catch (error) { setQuizError(error.message); }
    finally { setQuizLoadingId(null); }
  }

  async function submitQuiz() {
    if (!activeQuiz || Object.keys(answers).length !== activeQuiz.questions.length || quizSaving) return;
    setShowResults(true);
    setQuizSaving(true);
    setQuizSaveError('');
    try {
      const response = await fetch('/api/quiz/attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noteId: activeQuiz.noteId, questions: activeQuiz.questions, answers }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '점수를 저장하지 못했어요.');
      setAttemptResult(data);
      const savedAttempt = {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        note_id: activeQuiz.noteId,
        score: data.score,
        total: data.total,
        questions: activeQuiz.questions,
        answers,
        wrong_questions: data.wrongQuestions,
        next_review_at: data.nextReviewAt,
        created_at: new Date().toISOString(),
      };
      const nextAttempts = [savedAttempt, ...attempts];
      try {
        window.localStorage.setItem(ATTEMPTS_STORAGE_KEY, JSON.stringify(nextAttempts));
        setAttempts(nextAttempts);
      } catch {
        setQuizSaveError('점수는 확인했지만 브라우저 저장 공간에 기록을 저장하지 못했어요.');
      }
    } catch (error) {
      setQuizSaveError(`${error.message} 답은 확인했지만 기록은 저장하지 못했어요.`);
    } finally { setQuizSaving(false); }
  }

  function beginMetadataEdit(note) {
    setMetadataEditingId(note.id);
    setMetadataDraft({ title: note.title || '', subject: note.subject || '', tags: (note.tags || []).join(', ') });
  }

  async function saveMetadata(noteId) {
    const { error } = await supabase.from('notes').update({
      title: metadataDraft.title.trim(),
      subject: metadataDraft.subject.trim(),
      tags: metadataDraft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    }).eq('id', noteId);
    if (error) { setMessage(`노트 정보를 저장하지 못했어요: ${error.message}`); return; }
    setMetadataEditingId(null);
    await loadNotes();
  }

  function beginSummaryEdit(noteId, summary) {
    setSummaryEditingId(noteId);
    setSummaryDraft(summary?.summary || '');
    setKeywordsDraft((summary?.keywords || []).join(', '));
  }

  async function saveSummary(note) {
    const summary = note.note_summaries?.[0];
    const values = { summary: summaryDraft.trim(), keywords: keywordsDraft.split(',').map((word) => word.trim()).filter(Boolean) };
    const query = summary
      ? supabase.from('note_summaries').update(values).eq('id', summary.id)
      : supabase.from('note_summaries').insert({ ...values, note_id: note.id });
    const { error } = await query;
    if (error) { setMessage(`요약을 저장하지 못했어요: ${error.message}`); return; }
    setSummaryEditingId(null);
    await loadNotes();
  }

  function exportMarkdown(note) {
    const summary = note.note_summaries?.[0];
    const history = latestAttempts[note.id] || [];
    const content = [
      `# ${note.title || '학습 노트'}`,
      note.subject ? `과목: ${note.subject}` : '',
      `날짜: ${formatDate(note.created_at)}`,
      note.tags?.length ? `태그: ${note.tags.map((tag) => `#${tag}`).join(' ')}` : '',
      '', '## 요약', summary?.summary || '아직 요약이 없습니다.', '',
      '## 핵심 키워드', (summary?.keywords || []).map((word) => `- ${word}`).join('\n') || '- 없음', '',
      '## 퀴즈 기록', history.length ? history.slice(0, 10).map((attempt) =>
        `- ${formatDate(attempt.created_at)}: ${attempt.score}/${attempt.total}점 · 오답 ${attempt.wrong_questions?.length || 0}개`
      ).join('\n') : '- 아직 퀴즈 기록이 없습니다.',
      '', '## 오답 복습', history.flatMap((attempt) => attempt.wrong_questions || []).slice(0, 20).map((item) =>
        `- ${item.question}\n  - 내 답: ${item.selectedAnswer || '미응답'} / 정답: ${item.correctAnswer}\n  - ${item.explanation}`
      ).join('\n') || '- 오답이 없습니다.',
    ].filter((line) => line !== undefined).join('\n');
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(note.title || '학습노트').replace(/[\\/:*?"<>|]/g, '-')}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const score = activeQuiz?.questions.reduce((sum, question, index) => sum + (answers[index] === question.answerIndex ? 1 : 0), 0) || 0;

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top"><span className="brand-mark">N</span> 노트온</a>
        <span className="topbar-note">나만의 AI 학습 공간</span>
      </header>

      <div id="top" className="content">
        <section className="welcome">
          <div>
            <span className="eyebrow">STUDY, MADE SIMPLE</span>
            <h1>배운 내용을 모으고,<br /><span>내 것으로 만들어보세요.</span></h1>
            <p>노트 사진 한 장이면 AI가 핵심을 정리하고 복습까지 도와드려요.</p>
          </div>
          <div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-card">✦<small>오늘의 배움</small><b>한 장씩 차곡차곡</b></div><span className="art-sparkle">✧</span></div>
        </section>

        <section className="upload-card" aria-labelledby="upload-title">
          <div className="section-heading"><div><span className="eyebrow">NEW NOTE</span><h2 id="upload-title">오늘 공부한 내용을 추가해요</h2></div><span className="upload-icon">↑</span></div>
          <div className="metadata-fields">
            <label>노트 제목<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 세포의 구조" /></label>
            <label>과목<input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="예: 생명과학" /></label>
            <label>태그<input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="쉼표로 구분 · 세포, 시험 범위" /></label>
          </div>
          <label
            className={`dropzone ${files.length ? 'has-file' : ''} ${isDragging ? 'is-dragging' : ''}`}
            htmlFor="note-file"
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false); }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const incoming = Array.from(event.dataTransfer.files || []);
              setFiles((current) => mergeImageFiles(current, incoming));
              if (incoming.length) setMessage('사진을 업로드 대기열에 추가했어요.');
            }}
          >
            <span className="file-icon">▧</span>
            <strong>{isDragging ? '여기에 사진을 놓으세요' : files.length ? `${files.length}장의 사진이 대기 중` : '사진을 끌어놓거나 선택해주세요'}</strong>
            <span>여러 장 선택 가능 · 스크린샷은 Ctrl+V로 붙여넣기 · JPG, PNG, WEBP</span>
            <input id="note-file" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={(event) => {
              const incoming = Array.from(event.target.files || []);
              setFiles((current) => mergeImageFiles(current, incoming));
              if (incoming.length) setMessage(`${incoming.length}장을 업로드 대기열에 추가했어요.`);
              event.target.value = '';
            }} />
          </label>
          {files.length > 0 && <div className="queue-list" aria-label="업로드 대기열">
            {files.map((queuedFile, index) => <div className="queue-item" key={`${queuedFile.name}-${queuedFile.size}-${queuedFile.lastModified}`}><span className="queue-number">{String(index + 1).padStart(2, '0')}</span><span className="queue-name" title={queuedFile.name}>{queuedFile.name}</span><span className="queue-size">{(queuedFile.size / 1024 / 1024).toFixed(1)} MB</span><button type="button" aria-label={`${queuedFile.name} 제거`} disabled={busy} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}
            {!busy && files.length > 1 && <button type="button" className="queue-clear" onClick={() => setFiles([])}>대기열 비우기</button>}
          </div>}
          {uploadProgress && <div className="upload-progress" role="status"><div><span>{uploadProgress.phase}</span><strong>{uploadProgress.completed}/{uploadProgress.total}</strong></div><progress value={uploadProgress.completed} max={uploadProgress.total} /><small>{uploadProgress.name}</small></div>}
          <button className="primary-button" onClick={handleUpload} disabled={!files.length || busy}>{busy ? <><span className="spinner" />{files.length}장 순서대로 처리 중</> : <>사진 {files.length ? `${files.length}장` : ''} 올리고 요약하기 <span aria-hidden="true">→</span></>}</button>
          {message && <p className="status-message" role="status">{message}</p>}
        </section>

        <section className="library" aria-labelledby="library-title">
          <div className="library-heading">
            <div><span className="eyebrow">YOUR LIBRARY</span><h2 id="library-title">내 학습 노트 <span className="count-badge">{notes.length}</span></h2></div>
            <div className="stats"><span><b>{completedCount}</b> 정리 완료</span><span><b>{notes.length - completedCount}</b> 처리 중</span></div>
          </div>

          {dueNotes.length > 0 && <button className="review-banner" onClick={() => setFilter('due')}><span className="review-banner-icon">↻</span><span><strong>오늘 복습할 노트가 {dueNotes.length}개 있어요</strong><small>퀴즈 결과에 맞춰 복습 시점을 정했어요.</small></span><b>복습하기 →</b></button>}

          <div className="toolbar">
            <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목, 과목, 요약, 태그 검색" aria-label="노트 검색" /></label>
            <button className="print-button" onClick={() => window.print()}>PDF로 저장 / 인쇄</button>
            <div className="filter-tabs" aria-label="노트 필터">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}{value === 'due' && dueNotes.length > 0 ? ` ${dueNotes.length}` : ''}</button>)}</div>
          </div>

          {quizSaveError && !activeQuiz && <p className="setup-hint" role="status">{quizSaveError}</p>}
          {loadingNotes ? <div className="empty-state"><span className="spinner" />노트를 불러오고 있어요</div> : filteredNotes.length === 0 ? <div className="empty-state"><span className="empty-icon">✎</span><strong>{notes.length ? '검색 결과가 없어요' : '아직 저장된 노트가 없어요'}</strong><span>{notes.length ? '다른 단어로 검색하거나 필터를 바꿔보세요.' : '첫 번째 노트 사진을 올려 학습 기록을 시작해보세요.'}</span></div> : <div className="notes-grid">
            {filteredNotes.map((note) => {
              const summary = note.note_summaries?.[0];
              const noteAttempts = latestAttempts[note.id] || [];
              const latestAttempt = noteAttempts[0];
              const isDue = dueNotes.some((item) => item.id === note.id);
              return <article className="note-card" key={note.id}>
                <div className="note-top">
                  <img src={note.image_url} alt={`${note.title || '학습'} 노트 사진`} />
                  <div className="note-meta">
                    <span className={`status-pill ${note.status === 'done' ? 'done' : note.status === 'failed' ? 'failed' : 'pending'}`}><i />{note.status === 'done' ? '정리 완료' : note.status === 'failed' ? '분석 실패' : '분석 중'}</span>
                    <time>{formatDate(note.created_at)}</time>
                    {latestAttempt && <span className="last-score">최근 퀴즈 {latestAttempt.score}/{latestAttempt.total}</span>}
                  </div>
                  <button className="icon-button" title="Markdown으로 내보내기" aria-label={`${note.title || '노트'} Markdown 다운로드`} onClick={() => exportMarkdown(note)}>↓</button>
                </div>

                {metadataEditingId === note.id ? <div className="edit-fields">
                  <label>제목<input value={metadataDraft.title} onChange={(event) => setMetadataDraft({ ...metadataDraft, title: event.target.value })} /></label>
                  <label>과목<input value={metadataDraft.subject} onChange={(event) => setMetadataDraft({ ...metadataDraft, subject: event.target.value })} /></label>
                  <label>태그<input value={metadataDraft.tags} onChange={(event) => setMetadataDraft({ ...metadataDraft, tags: event.target.value })} placeholder="쉼표로 구분" /></label>
                  <div className="edit-actions"><button className="text-button" onClick={() => setMetadataEditingId(null)}>취소</button><button className="small-action" onClick={() => saveMetadata(note.id)}>정보 저장</button></div>
                </div> : <div className="note-title-row"><div><h3 className="note-title">{note.title || '제목 없는 노트'}</h3><div className="note-subject">{note.subject || '과목 미지정'}</div></div><button className="text-button" onClick={() => beginMetadataEdit(note)}>편집</button></div>}
                {note.tags?.length > 0 && <div className="keywords metadata-tags">{note.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}

                {note.status === 'failed' ? <div className="failed-box"><p>{note.error_message || '사진을 분석하지 못했어요. 다시 시도해주세요.'}</p><button className="retry-button" onClick={() => retryAnalysis(note.id)} disabled={retryingId !== null}>{retryingId === note.id ? <><span className="spinner small" />다시 분석 중</> : '다시 분석하기 →'}</button></div> : note.status === 'pending' ? <div className="pending-box"><span className="spinner small" />사진에서 내용을 읽고 있어요.</div> : <>
                  <div className="summary-heading"><h4>핵심 요약</h4><button className="text-button" onClick={() => beginSummaryEdit(note.id, summary)}>요약 편집</button></div>
                  {summaryEditingId === note.id ? <div className="edit-fields summary-editor"><label>요약<textarea rows="5" value={summaryDraft} onChange={(event) => setSummaryDraft(event.target.value)} /></label><label>핵심 키워드<input value={keywordsDraft} onChange={(event) => setKeywordsDraft(event.target.value)} placeholder="쉼표로 구분" /></label><div className="edit-actions"><button className="text-button" onClick={() => setSummaryEditingId(null)}>취소</button><button className="small-action" onClick={() => saveSummary(note)}>요약 저장</button></div></div> : <><p className="summary-text">{summary?.summary || '요약이 없습니다.'}</p><div className="keywords">{(summary?.keywords || []).map((word) => <span key={word}>#{word}</span>)}</div></>}

                  {latestAttempt && <div className="review-date"><span>마지막 복습 {formatDate(latestAttempt.created_at)}</span><span className={isDue ? 'due-label' : ''}>{isDue ? '오늘 복습할 차례' : `다음 복습 ${formatDate(latestAttempt.next_review_at)}`}</span></div>}
                  <button className="quiz-button" onClick={() => createQuiz(note.id)} disabled={quizLoadingId !== null}>{quizLoadingId === note.id ? <><span className="spinner small" />문제를 준비하고 있어요</> : <>✦ 이 노트로 복습하기 <span>→</span></>}</button>
                  {quizError && quizLoadingId === null && !activeQuiz && <p className="error-message" role="alert">{quizError}</p>}

                  {noteAttempts.length > 0 && <details className="attempt-history"><summary>퀴즈 기록 {noteAttempts.length}회 · 오답 복습</summary><div className="attempt-list">{noteAttempts.slice(0, 5).map((attempt) => <div className="attempt-item" key={attempt.id}><div className="attempt-line"><strong>{attempt.score}/{attempt.total}점</strong><time>{formatDate(attempt.created_at, { month: 'short', day: 'numeric' })}</time></div>{attempt.wrong_questions?.length > 0 ? <ul>{attempt.wrong_questions.map((wrong, index) => <li key={`${attempt.id}-${index}`}><b>{wrong.question}</b><span>내 답: {wrong.selectedAnswer || '미응답'} · 정답: {wrong.correctAnswer}</span><small>{wrong.explanation}</small></li>)}</ul> : <p className="all-correct">모두 맞혔어요. 다음 복습은 {formatDate(attempt.next_review_at)}이에요.</p>}</div>)}</div></details>}

                  {activeQuiz?.noteId === note.id && <section className="quiz-panel"><div className="quiz-title"><div><span className="eyebrow">QUICK REVIEW</span><h3>복습 퀴즈</h3></div><button className="text-button" onClick={() => { setActiveQuiz(null); setShowResults(false); setAttemptResult(null); }}>닫기</button></div>
                    {activeQuiz.questions.map((question, index) => <fieldset className="question" key={index}><legend><b>{String(index + 1).padStart(2, '0')}</b>{question.question}</legend><div className="options">{question.options.map((option, optionIndex) => <label className={showResults && optionIndex === question.answerIndex ? 'correct' : showResults && answers[index] === optionIndex ? 'incorrect' : ''} key={optionIndex}><input type="radio" name={`question-${note.id}-${index}`} checked={answers[index] === optionIndex} disabled={showResults} onChange={() => setAnswers((current) => ({ ...current, [index]: optionIndex }))} />{option}</label>)}</div>{showResults && <p className="explanation">{answers[index] === question.answerIndex ? '정답이에요! ' : `정답: ${question.options[question.answerIndex]}. `}{question.explanation}</p>}</fieldset>)}
                    {showResults ? <div className="score-result"><p>이번 점수 <strong>{attemptResult?.score ?? score} / {attemptResult?.total ?? activeQuiz.questions.length}</strong></p>{quizSaving ? <span><span className="spinner small" />점수와 오답을 저장하고 있어요</span> : attemptResult ? <span>{quizSaveError || `다음 복습일은 ${formatDate(attemptResult.nextReviewAt)}예요.`}</span> : quizSaveError ? <span className="error-message">{quizSaveError}</span> : null}</div> : <button className="primary-button quiz-submit" onClick={submitQuiz} disabled={Object.keys(answers).length !== activeQuiz.questions.length}>답안 확인하고 기록하기 →</button>}
                  </section>}
                </>}
              </article>;
            })}
          </div>}
        </section>
        <footer className="footer">작은 기록이 쌓여 큰 배움이 됩니다 <span>✦</span></footer>
      </div>
    </main>
  );
}
