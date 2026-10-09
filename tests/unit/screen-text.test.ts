import { describe, expect, it } from 'vitest'
import { hasNewContent, looksAnswerable, sameScreenText, screenWords } from '../../src/shared/screen-text'

describe('screen text heuristics for auto answers', () => {
  it('spots questions, tasks, problems, options and errors', () => {
    expect(looksAnswerable('Interview Question 3\n• Which data structure gives O(1) average lookup by key?')).toBe(true)
    expect(looksAnswerable('Design a URL shortener that handles 10k writes per second')).toBe(true)
    expect(looksAnswerable('Given an array of integers, return indices of the two numbers.\nExample 1:\nInput: nums = [2,7,11,15]')).toBe(true)
    expect(looksAnswerable('A) Linked list   B) Hash table')).toBe(true)
    expect(looksAnswerable('Traceback (most recent call last):\n  File "app.py", line 3')).toBe(true)
    expect(looksAnswerable('Sam: can we ship this on Friday?')).toBe(true)
    expect(looksAnswerable('Q2: Reverse a linked list in place')).toBe(true)
  })

  it('ignores plain content', () => {
    expect(looksAnswerable('Quarterly Revenue Review\n• Q3 revenue grew 18 percent to 4.2 million dollars\n• Customer churn decreased to 2.1 percent')).toBe(false)
    expect(looksAnswerable('File Edit View Help\nInbox (3)\nWhy?')).toBe(false)
    expect(looksAnswerable('')).toBe(false)
  })

  it('treats small OCR differences as the same screen, and new content as different', () => {
    const a = screenWords('Interview Question 3\nWhich data structure gives O(1) average lookup by key?\nA) Linked list B) Hash table\nC) Binary heap D) Sorted array\n10:41 AM')
    const sameish = screenWords('Interview Question 3\nWhich data structure gives O(1) average lookup by key?\nA) Linked list B) Hash table\nC) Binary heap D) Sorted array\n10:42 AM')
    const next = screenWords('Interview Question 4\nWhat is the time complexity of quicksort in the worst case?')
    expect(sameScreenText(a, sameish)).toBe(true)
    expect(sameScreenText(a, next)).toBe(false)
    expect(sameScreenText(new Set(), new Set())).toBe(true)
  })

  it('counts only added words as new content, so a new chat message is new but scrolling back is not', () => {
    const chat = screenWords('Alice: morning all\nBob: the deploy finished\nAlice: great, metrics look fine\n'.repeat(5))
    const withQuestion = screenWords([...chat].join(' ') + '\nCarol: which region should we fail over to first?')
    expect(hasNewContent(withQuestion, [chat])).toBe(true)
    expect(hasNewContent(chat, [withQuestion])).toBe(false) // scrolled back / message gone
    expect(hasNewContent(screenWords('Interview Question 3 10:42'), [screenWords('Interview Question 3 10:41')])).toBe(false)
    expect(hasNewContent(screenWords('anything'), [])).toBe(true)
  })
})
