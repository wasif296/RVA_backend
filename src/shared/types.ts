export type Role = 'super_admin' | 'user';

export type CourseStatus = 'draft' | 'published' | 'archived';

export type CourseLevel = 'beginner' | 'intermediate' | 'advanced';

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface HealthResponse {
  status: 'ok';
  uptimeSec: number;
  db: string;
  timestamp: string;
}

export const RULES = {
  VIDEO_COMPLETION_RATIO: 0.9,
  VIDEO_POINTS: 5,
  DEFAULT_POINTS_PER_QUESTION: 1,
  DEFAULT_PASSING_SCORE_PCT: 70,
  /** Written final exam — fixed marks; tutor-graded (grading is a later phase). */
  FINAL_EXAM_MAX_MARKS: 50,
  FINAL_EXAM_PASS_PCT: 80,
  SEQUENTIAL_LESSON_UNLOCK: true,
  QUIZ_REQUIRED_FOR_LESSON_COMPLETION: true,
  UNLIMITED_QUIZ_ATTEMPTS: true,
} as const;

export function finalExamPassMark(
  maxMarks: number = RULES.FINAL_EXAM_MAX_MARKS,
): number {
  return Math.ceil((maxMarks * RULES.FINAL_EXAM_PASS_PCT) / 100);
}
