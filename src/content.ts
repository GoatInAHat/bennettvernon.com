export interface WorkItem {
  title: string
  subtitle: string
  date: string
  description: string
}

export const site = {
  name: 'Bennett Vernon',
  description: 'I like to build things, check out some of them here.',
  links: [
    { label: 'GitHub', href: 'https://github.com/GoatInAHat' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/bennett-vernon-79b298249/' },
    { label: 'X', href: 'https://x.com/bennetttvernon' },
  ],
}

export const projects: WorkItem[] = [
  {
    title: 'ACRE Robotics',
    subtitle: 'Co-Founder, CTO',
    date: 'Mar 2025',
    description:
      'Raised **$750k** and became the fastest team to build an autonomous tractor. Developed the robotic actuation stack for tractor autonomy and closed additional funding through demos.',
  },
  {
    title: 'SafetySpect, Inc',
    subtitle: 'Engineering Intern',
    date: 'Jan 2024',
    description:
      'Developed electronics and software for the cooling system on a project to grow vegetables on the International Space Station. Invented a testing suite for proprietary LED drivers to maximize efficient product development for the USDA.',
  },
]

export const research: WorkItem[] = []

export const work: WorkItem[] = [
  {
    title: 'Rolling Robots',
    subtitle: 'Instructor',
    date: 'Jun 2023',
    description:
      'Taught 150+ elementary and middle school students programming and robotics concepts through hands-on lessons. Coached world-championship-level teams and helped run a summer program at a new location.',
  },
  {
    title: 'The Jim Henson Company',
    subtitle: 'Software Engineering Intern',
    date: 'Jun 2021',
    description:
      'Engineered user-friendly software for puppeteers to adjust control settings of personalized animatronics controllers. Enabled performers to quickly fine tune parameters for characters in productions such as Netflix’s _The Dark Crystal_.',
  },
  {
    title: 'Aventre',
    subtitle: 'Founder, Developer, UI/UX Designer',
    date: 'Nov 2024',
    description:
      'Rapid-prototyped a SaaS mapping campus startups, support programs, and available talent to accelerate student team formation. Streamlined venture building by surfacing talent matches and startup opportunities.',
  },
  {
    title: 'CodeRace',
    subtitle: 'Co-Founder, Developer, UI/UX Designer',
    date: 'Sep 2024',
    description:
      'Designed and built a “multiplayer leetcode” platform for CS students to practice technical interview questions with friends. Added game elements like changing the language your opponent is working in.',
  },
  {
    title: 'AP Practice Website',
    subtitle: 'Founder, Developer, UI/UX Designer',
    date: 'Mar 2023',
    description:
      'Created a website with 20,000 AP practice questions across 19 courses, filling a gap in study materials. Gamified studying with correct answer streaks and high scores for short 5–10 minute sessions.',
  },
  {
    title: 'Discord Bot',
    subtitle: 'Founder, Developer, UI/UX Designer',
    date: 'Jun 2020',
    description:
      'Created a Discord bot that gained over **1 million** users with a thriving online community and recurring revenue. Enabled users to share short-form videos/images and play games within the app.',
  },
]
