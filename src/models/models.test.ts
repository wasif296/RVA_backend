import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Course } from './Course.js';
import { Lesson } from './Lesson.js';
import { Progress } from './Progress.js';
import { Quiz } from './Quiz.js';
import { User } from './User.js';

describe('Phase 3 models', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all([Lesson.syncIndexes(), Progress.syncIndexes(), Quiz.syncIndexes()]);
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Course.deleteMany({}),
      Lesson.deleteMany({}),
      Quiz.deleteMany({}),
      Progress.deleteMany({}),
    ]);
  });

  async function createCourse() {
    const admin = await User.create({
      name: 'Admin',
      email: 'admin@test.local',
      passwordHash: 'hash',
      role: 'super_admin',
    });

    return Course.create({
      title: 'Test Course',
      slug: `test-course-${admin._id.toString()}`,
      description: 'A course for model tests',
      category: 'Test',
      level: 'beginner',
      status: 'published',
      createdBy: admin._id,
    });
  }

  it('hides correctIndex by default and returns it when explicitly selected', async () => {
    const course = await createCourse();
    const lesson = await Lesson.create({
      courseId: course._id,
      title: 'Lesson 1',
      description: 'First lesson',
      youtubeVideoId: 'M7lc1UVf-VE',
      durationSec: 100,
      order: 10,
    });

    await Quiz.create({
      scope: 'lesson',
      courseId: course._id,
      lessonId: lesson._id,
      title: 'Quiz 1',
      questions: [
        {
          text: 'Pick one',
          options: ['A', 'B', 'C'],
          correctIndex: 1,
          order: 1,
        },
      ],
    });

    const defaultQuiz = await Quiz.findOne({ lessonId: lesson._id }).lean();
    expect(defaultQuiz).not.toBeNull();
    expect(defaultQuiz?.questions[0]).toBeDefined();
    expect(defaultQuiz?.questions[0]).not.toHaveProperty('correctIndex');

    const selectedQuiz = await Quiz.findOne({ lessonId: lesson._id })
      .select('+questions.correctIndex')
      .lean();
    expect(selectedQuiz?.questions[0]?.correctIndex).toBe(1);
  });

  it('rejects duplicate lesson order within the same course', async () => {
    const course = await createCourse();

    await Lesson.create({
      courseId: course._id,
      title: 'Lesson A',
      description: 'A',
      youtubeVideoId: 'M7lc1UVf-VE',
      durationSec: 100,
      order: 10,
    });

    await expect(
      Lesson.create({
        courseId: course._id,
        title: 'Lesson B',
        description: 'B',
        youtubeVideoId: 'aqz-KE-bpKQ',
        durationSec: 120,
        order: 10,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects duplicate Progress for the same user and course', async () => {
    const course = await createCourse();
    const user = await User.create({
      name: 'Learner',
      email: 'learner@test.local',
      passwordHash: 'hash',
      role: 'user',
    });

    await Progress.create({
      userId: user._id,
      courseId: course._id,
      lessons: [],
    });

    await expect(
      Progress.create({
        userId: user._id,
        courseId: course._id,
        lessons: [],
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('auto-sets requiredWatchSec to 90% of durationSec', async () => {
    const course = await createCourse();
    const lesson = await Lesson.create({
      courseId: course._id,
      title: 'Timed lesson',
      description: 'Duration check',
      youtubeVideoId: 'jNQXAC9IVRw',
      durationSec: 100,
      order: 10,
    });

    expect(lesson.requiredWatchSec).toBe(90);
  });

  it('fails validation when correctIndex is outside the options range', async () => {
    const course = await createCourse();
    const lesson = await Lesson.create({
      courseId: course._id,
      title: 'Lesson 1',
      description: 'First lesson',
      youtubeVideoId: 'M7lc1UVf-VE',
      durationSec: 100,
      order: 10,
    });

    await expect(
      Quiz.create({
        scope: 'lesson',
        courseId: course._id,
        lessonId: lesson._id,
        title: 'Bad quiz',
        questions: [
          {
            text: 'Pick one',
            options: ['A', 'B'],
            correctIndex: 5,
            order: 1,
          },
        ],
      }),
    ).rejects.toThrow(/correctIndex/i);
  });
});
