export default function handler(req,res){
  res.status(200).json({
    ok:true,
    geminiKeyConfigured:Boolean(process.env.GEMINI_API_KEY),
    openaiKeyConfigured:Boolean(process.env.OPENAI_API_KEY),
    vercelEnv:process.env.VERCEL_ENV||'unknown',
    branch:process.env.VERCEL_GIT_COMMIT_REF||'unknown'
  });
}
