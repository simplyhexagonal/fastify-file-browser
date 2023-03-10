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
  .option('max-file-size', {
    describe: 'Maximum file size (in bytes) that can be uploaded to the server',
    type: 'number',
    default: 20 * 1024 * 1024, // 20 MB
  })
  .help()
  .alias('help', 'h')
  .argv;

// console.log('CLI arguments:', argv);

const {
  port,
  host,
  allowFileUploads,
  showHiddenFiles,
  maxFileSize,
} = argv;

const sanitizeErrorString = (errorString: string) => {
  return errorString.replaceAll(
    process.cwd(),
    '',
  );
};

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

server.register(
  fastifyMultipart,
  {
    limits: {
      fileSize: maxFileSize,
    },
  },
);

const replyTree = ({
  files,
  newPath,
}: {
  files: string[],
  newPath: string,
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

  return {
    directories: directoryObjects,
    files: fileObjects,
  };
};

// Intercept the request and modify it as needed
server.addHook('preHandler', async (request, reply) => {
  const requestedPath = request.url;

  const {
    path: filePath,
    newFileName,
  } = request.query as any;

  console.log(`Requested path: ${requestedPath}`);

  // If requested path matches malicious regex return error
  if (`${requestedPath} ${filePath} ${newFileName}`.match(/\.\./g)) {
    console.error(
      `Malicious request detected:`,
      {
        requestedPath,
        filePath,
        newFileName,
      },
    );

    reply.status(400).send('Bad Request');
    return;
  }

  // If the requested path is just "/", return an empty string with header content-type for an html file
  if (requestedPath === '/') {
    reply.type('text/html').send(html);
    return;
  }

  // If the requested path is just "/", return an empty string with header content-type for an html file
  if (requestedPath === '/favicon.ico') {
    reply.type('image/x-icon').send('');
    return;
  }

  // If the requested path does not contain "/fs", let request through to route handlers
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
      console.error(error);

      reply.status(404).send(
        {
          success: false,
          message: {
            errors: ['Directory not found'],
          },
        },
      );
    }

    // Run glob on the directory
    await glob(path.join(absolutePath, '*'), {dot: showHiddenFiles}).then(
      (files) => reply.send(
        {
          success: true,
          message: replyTree({ files, newPath }),
        }
      )
    ).catch(
      (error) => {
        console.error(error);

        reply.status(500).send(
          {
            success: false,
            message: {
              errors: [sanitizeErrorString(error.message)],
            },
          },
        );
      }
    );
  }

  // If newPath does not end with a trailing slash, rewrite the request path and continue as usual
  reply.redirect(`/${newPath}`);
});

if (allowFileUploads) {
  server.post('/upload', async (request, reply) => {
    const { path: filePath } = request.query as any;

    const files = await request.files();

    const errors = [];

    const newPath = filePath.replace(/^\/fs\//, '');

    try {
      // Check if the directory is writable
      fs.accessSync(path.join(process.cwd(), newPath), fs.constants.W_OK);

      // Use async for...of loop to iterate over the async iterable
      for await (const file of files) {
        if (file.file) {
          const fileName = file.filename;
          const fileData = file.file;

          const fullPath = path.join(process.cwd(), newPath, fileName);

          console.log('Writing:', fullPath);

          await pump(fileData, fs.createWriteStream(fullPath)).catch(
            (error) => {
              errors.push(sanitizeErrorString(error.message));
            }
          );
        }
      }

      if (errors.length) {
        console.error(errors);

        reply.code(500).send(
          {
            success: false,
            message: errors,
          },
        );
      }

      reply.send({ success: true });
    } catch (error) {
      console.error(error);

      reply.code(500).send(
        {
          success: false,
          message: {
            errors: [sanitizeErrorString(error.message)],
          },
        },
      );
    }
  });

  server.delete('/delete', async (request, reply) => {
    const { path: filePath } = request.query as any;

    const newPath = filePath.replace(/^\/fs\//, '');

    try {
      // Delete file using newPath
      fs.unlinkSync(path.join(process.cwd(), newPath));

      reply.send({ success: true });
    } catch (error) {
      console.error(error);

      reply.code(500).send(
        {
          success: false,
          message: {
            errors: [sanitizeErrorString(error.message)],
          },
        },
      );
    }
  });

  server.put('/rename', async (request, reply) => {
    const {
      path: filePath,
      newFileName,
    } = request.query as any;

    const originalPath = filePath.replace(/^\/fs\//, '');
    const newPath = path.join(path.dirname(originalPath), newFileName);

    try {
      // Rename file using originalPath and newPath
      fs.renameSync(
        path.join(process.cwd(), originalPath),
        path.join(process.cwd(), newPath),
      );

      reply.send({ success: true });
    } catch (error) {
      console.error(error);

      reply.code(500).send(
        {
          success: false,
          message: {
            errors: [sanitizeErrorString(error.message)],
          },
        },
      );
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
