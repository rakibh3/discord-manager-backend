import app from '@/app';
import { prisma } from '@/lib/prisma';

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    await prisma.$connect();
    // eslint-disable-next-line no-console
    console.log('Connected to the database successfully.');

    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('An error occurred:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
