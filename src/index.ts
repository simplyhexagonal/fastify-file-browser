import fs from 'fs';
import path from 'path';
import util from 'util';
import { pipeline } from 'stream';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fastify, {FastifyReply} from 'fastify';
import fastifyStatic from '@fastify/static';
import glob from 'glob';
import mime from 'mime-types';
import fastifyMultipart from '@fastify/multipart';

// @ts-ignore
import {version} from '../package.json';

const argv = yargs(hideBin(process.argv))
  .option('port', {
    describe: 'Port number to listen on',
    type: 'number',
    default: 3000,
  })
  .option('host', {
    describe: 'Host name to bind to (use \'0.0.0.0\' to expose to the network)',
    type: 'string',
    default: 'localhost',
  })
  .option('allow-file-uploads', {
    describe: 'Allow file uploads to the server',
    type: 'boolean',
    default: false,
  })
  .option('show-hidden-files', {
    describe: 'Show hidden files in directory listings',
    type: 'boolean',
    default: false,
  })
  .help()
  .alias('help', 'h')
  .argv;

// console.log('CLI arguments:', argv);

const port = argv.port || 3000;
const host = argv.host || '0.0.0.0';
const allowFileUploads = argv.allowFileUploads || false;
const showHiddenFiles = argv.showHiddenFiles || false;

const pump = util.promisify(pipeline);

const server = fastify();

// let runningAddress = `http://${host}:${port}`;

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

html = html.replace(
  /["]\/assets[^"]+\.svg["]/g,
  (match) => {
    const assetPath = match.replace(/["]/g, '');

    const assetContents = fs.readFileSync(path.join(__dirname, assetPath), 'utf8');

    return assetContents;
  },
);

html = html.replace(
  /[']\/assets[^']+\.svg[']/g,
  (match) => {
    const assetPath = match.replace(/[']/g, '');

    const assetContents = fs.readFileSync(path.join(__dirname, assetPath), 'utf8');

    return `'${assetContents}'`;
  },
);

html = html.replace(
  /["]\/assets[^"]+\.css["]/g,
  (match) => {
    const assetPath = match.replace(/["]/g, '');

    const assetContents = fs.readFileSync(path.join(__dirname, assetPath), 'utf8');

    return `<style>\n${assetContents}\n\t</style>`;
  },
);

html = html.replace(
  /ALLOW_FILE_UPLOADS/g,
  allowFileUploads ? 'true' : 'false',
);

// Serve the current working directory using fastifyStatic
server.register(fastifyStatic, {
  root: process.cwd(),
  prefix: '/',
});

server.register(fastifyMultipart);

const replyTree = ({
  files,
  newPath,
  reply,
}: {
  files: string[],
  newPath: string,
  reply: FastifyReply,
}) => {
  // Prepend "/fs/" to the file paths in the array
  const mappedObjects = files.map(
    (file) => {
      const isDirectory = fs.lstatSync(file).isDirectory();

      return {
        name: path.basename(file),
        path: `/fs/${newPath}${path.basename(file)}${isDirectory ? '/' : ''}`,
        mimeType: (
          isDirectory
        ) ? (
          'inode/directory'
        ) : (
          mime.lookup(`/fs/${newPath}${path.basename(file)}`) || 'application/octet-stream'
        ),
      };
    },
  );
  const directoryObjects = mappedObjects.filter(
    (file) => (
      file.mimeType === 'inode/directory'
    ),
  ).sort(
    (a, b) => {
      const aPath = a.path.toLowerCase();
      const bPath = b.path.toLowerCase();

      return aPath.localeCompare(bPath, undefined, { numeric: true });
    },
  );
  const fileObjects = mappedObjects.filter(
    (file) => (
      file.mimeType !== 'inode/directory'
    ),
  ).sort(
    (a, b) => {
      const aPath = a.path.toLowerCase();
      const bPath = b.path.toLowerCase();

      return aPath.localeCompare(bPath, undefined, { numeric: true });
    },
  );
  reply.send(
    {
      directories: directoryObjects,
      files: fileObjects,
    }
  );
};

// Intercept the request and modify it as needed
server.addHook('preHandler', async (request, reply) => {
  const requestedPath = request.url;

  console.log(`Requested path: ${requestedPath}`);

  if (requestedPath === '/') {
    // If the requested path is just "/", return an empty string with header content-type for an html file
    reply.type('text/html').send(html);
    return;
  }

  if (requestedPath === '/favicon.ico') {
    // If the requested path is just "/", return an empty string with header content-type for an html file
    reply.type('image/x-icon').send('');
    return;
  }

  if (!(/^\/fs/).test(requestedPath)) {
    return;
  }

  // Remove "/fs/" from the requested path
  const newPath = requestedPath.replace(/^\/fs\//, '');

  if (newPath.endsWith('/') || newPath === '') {
    // If newPath ends with a trailing slash, assume it's a directory and check whether it exists
    const absolutePath = path.join(process.cwd(), newPath);

    try {
      await fs.promises.access(absolutePath);
    } catch (error) {
      reply.status(404).send({ error: 'Directory not found' });
    }

    // Run glob on the directory
    await glob(path.join(absolutePath, '*'), {dot: showHiddenFiles}).then(
      (files) => replyTree({ files, newPath, reply })
    ).catch(
      (error) => {
        reply.status(500).send({ error: error.message });
      }
    );
  }

  // If newPath does not end with a trailing slash, rewrite the request path and continue as usual
  reply.redirect(`/${newPath}`);
});

if (allowFileUploads) {
  server.post('/upload', async (request, reply) => {
    const { path: filePath } = request.query as any;

    const data = await request.file()

    // stream

    const fileName = data.filename;
    const fileData = data.file;

    try {
      const newPath = filePath.replace(/^\/fs\//, '');

      const fullPath = path.join(process.cwd(), newPath, fileName);

      await pump(fileData, fs.createWriteStream(fullPath));

      await glob(path.join(process.cwd(), newPath, '*'), {}).then(
        (files) => replyTree({ files, newPath, reply })
      ).catch(
        (error) => {
          reply.status(500).send({ error: error.message });
        }
      );
    } catch (err) {
      reply.code(500).send({ success: false, message: err.message });
    }
  });
}

console.log(`Starting server, version: ${version}`);

// Start the server
server.listen({port, host}, (error, address) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }

  // runningAddress = address;

  console.log(`Server listening on ${address}`);
});