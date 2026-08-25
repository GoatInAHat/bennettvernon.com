export interface ContentItem {
  title: string
  subtitle: string
  date?: string
  description: string
  links?: { label: string; href: string }[]
  photos?: string[]
}

export const site = {
  name: 'Bennett Vernon',
  description: 'I like to build things, check out some of them here.',
  socials: [
    { label: 'github', href: 'https://github.com/GoatInAHat' },
    { label: 'linkedin', href: 'https://www.linkedin.com/in/bennett-vernon-79b298249/' },
    { label: 'x', href: 'https://x.com/bennetttvernon' },
    { label: 'insta', href: 'https://www.instagram.com/bennetttvernon/' },
    { label: 'email', href: 'mailto:bennett.g.vernon@gmail.com' }
  ],
}

export const current: ContentItem[] = [
  {
    title: 'Beer',
    subtitle: 'experiment',
    description:
      'Multi-agent system based on Stafford Beer\'s Viable System Model. Aims to create an autonomous system for self-organizing, self-regulating, and self-improving enterprises fractally composed of agents. Experiments with **RSI**, online RL, and applied **[Agent Cybernetics](https://arxiv.org/pdf/2605.10754)**.',
  },
  {
    title: 'Recursive Agent Framework',
    subtitle: 'experiment',
    description:
      'Precursor to Beer. Experimental framework for massively decomposed agentic processes using recursively-organized teams of agents for problem decomposition. Improved performance of **Llama-8b** to past that of **Llama-70b** and **Claude Sonnet 4.6** on **GSM8K**. Presented at **VURS 2026**.',
    links: [
      { label: 'repo', href: 'https://aventre-labs.github.io/raf-demo/' },
      { label: 'paper', href: 'https://aventre-labs.github.io/raf-demo/RAF-Paper.pdf' },
      { label: 'demo', href: 'https://aventre-labs.github.io/raf-demo/' },
    ]
  },
  {
    title: 'Engraphia',
    subtitle: 'experiment',
    description:
      'A Training-Free Hierarchical Dynamic Memory for Transformer Inference. Aims to provide autoregressive transformer models of any modality that weren\'t built with long-term memory in mind with a memory system in the native language of their internal activation states. Works on direct KV cache manipulation, requires no additional tool-calling or fine-tuning.',
    links: [
      { label: 'whitepaper', href: 'https://pub-b447e42c9d6b4e50bac166262888ff2a.r2.dev/vernon/unpublished/pdf/Vernon%20-%202026%20-%20Engraphia.pdf' },
    ]
  },
]

export const projects: ContentItem[] = [
  {
    title: 'ACRE Robotics',
    subtitle: 'venture · cofounder, cto',
    date: '2025',
    description:
      'Fastest team to build a fully **autonomous tractor** (against other agtech startups: Bear Flag Robotics, Sabanto, etc.). Developed the robotic actuation stack, control systems, onboard AI. Raised **$750k** at **$5M**, assembled a team of 10 from Vanderbilt, MIT, Stanford, CMU, and Berkeley.',
    links: [
      { label: 'launch video', href: 'https://www.youtube.com/watch?v=54Q49bmkKLo' },
      { label: 'website', href: 'https://www.acre-robotics.com' },
      { label: 'linkedin', href: 'https://www.linkedin.com/company/acre-robotics/' },
    ],
    photos: ['/photos/acre/1.jpg', '/photos/acre/2.jpg', '/photos/acre/3.jpg'],
  },
  {
    title: 'Electric CRF150RB',
    subtitle: 'project',
    date: '2025',
    description:
      'Converted a Honda CRF150RB to electric (in my Vanderbilt dorm) with an **E&C** billet **QS138v3**, Noisy Cricket controller, 76v 32ah battery, and beautiful CNC work from **[quasaremotosports](https://quasaremotosports.com)**. 23 -> 30 hp, 14 -> 190 Nm. More coming soon with vehicle dynamics control systems.',
    photos: ['/photos/crf/1.jpg', '/photos/crf/2.jpg', '/photos/crf/3.jpg', '/photos/crf/4.jpg'],
  },
  {
    title: 'Testing Equipment for Hyperspectral Camera LED Driver Arrays',
    subtitle: 'embedded systems & software engineer @ **SafetySpect**',
    date: '2024',
    description:
      'Created automated test equipment for proprietary LED drivers for hyperspectral camera arrays. Applications included food safety, healthcare, agriculture, and military. Customers included **NASA**, **NOAA**, **USDA**, and **U.S. Army**.',
    links: [
      { label: 'website', href: 'https://www.safetyspect.com' },
      { label: 'linkedin', href: 'https://www.linkedin.com/company/safetyspect/' }
    ]
  },
  {
    title: 'Cooling System for ISS Astrobotany Lighting',
    subtitle: 'embedded systems & software engineer @ **SafetySpect**',
    date: '2024',
    description:
      'Developed electronics and software for the light-bar cooling system on a project to grow vegetables on the **International Space Station** for **NASA**. Created control loop software, schematic for custom PCB, documented code and circuits for installation and maintenance by astronauts. No teammates, but mentored by an ex-Soviet aerospace engineer who didn\'t speak English. Sent up by a Falcon 9 rocket and currently on the ISS.',
    links: [
      { label: 'website', href: 'https://www.safetyspect.com' },
      { label: 'linkedin', href: 'https://www.linkedin.com/company/safetyspect/' }
    ]
  },
  {
    title: 'AP Exam Practice Site',
    subtitle: 'project',
    date: '2023',
    description:
      'Everywhere that offered AP exam practice problems was paywalled or forced you to sit through entire practice exams, so I made a simple practice site with **20,000** AP practice questions across **19** courses. I wrote it in 2 days, nothing special, but I included it here because it was the first time I\'d had a lot of people I knew using something I made. I told probably 10 people about it then forgot it until I started getting messages from Buckley students, and from there it spread around high schools in LA, **~1k users** total.',
    links: [
      { label: 'website', href: 'http://ap-practice.bennettvernon.com' },
    ]
  },
  {
    title: 'Eugene Mk II & III',
    subtitle: 'project',
    date: '2022 & 2023',
    description:
      'VEX VRC Robots for **Tipping Point** and **Spin Up**. Local & regional wins & awards, World Championship quarterfinalist.',
    photos: ['/photos/eugene/1.jpg', '/photos/eugene/2.jpg'],
  },
  {
    title: 'Animatronics Control System',
    subtitle: 'software engineering intern @ **The Jim Henson Company**',
    date: '2021',
    description:
      'Developed software for puppeteers to adjust control settings of personalized animatronics controllers. Enabled performers to quickly fine-tune parameters for characters running Henson\'s CHI system.',
    links: [
      { label: 'website', href: 'https://www.henson.com' },
      { label: 'linkedin', href: 'https://www.linkedin.com/company/the-jim-henson-company/' }
    ]
  },
  {
    title: 'AutoMemes Discord Bot',
    subtitle: 'project',
    date: '2020',
    description:
      'I\'ve been coding since 4th grade, but this was my first public project at 14 years old. **1 million** users in 1.5 years, my first little bit of monthly revenue. Enabled users to share short-form videos/images and play games within Discord. Created the first serverless hosting architecture for Discord bots in **Rust** to handle the load.',
  },
]
