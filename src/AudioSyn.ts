import fs from 'fs';
import path from 'path';
import { audioRecordingInfo } from './index';
import ffmpeg from 'fluent-ffmpeg';

interface AudioInfo {
  filename: string;
  startTime: Date;
}

export async function processAudioFiles(folderPath: string): Promise<void> {
  const audioFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.wav'));
  const audioInfos: AudioInfo[] = [];
  for (const file of audioFiles) {
    const username = file.split('_')[0];
    const audioInfo = await audioRecordingInfo.findOne({ fileName: `${username}_audioInfo` });
    if (audioInfo && audioInfo.audioInfo.length > 0) {
      let [hours, minutes, seconds, milliseconds] = [0,0,0,0];
      if (audioInfo.audioInfo[0].currentTime) {
        [hours, minutes, seconds, milliseconds] = audioInfo.audioInfo[0].currentTime.split(',').map(Number);
      }
      const startTime = new Date();
      startTime.setHours(hours, minutes, seconds, milliseconds);
      audioInfos.push({ filename: file, startTime });
    }
  }
  
  // 找出开始时间最早的音频文件
  // const earliestAudio = audioInfos.sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0];
  const LatestAudio = audioInfos.sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0];
  let pathListForMerge: string[] = [];

  // 使用Promise.all来等待所有文件处理完成
  await Promise.all(audioInfos.map(info => addSilenceAndMerge(info, LatestAudio, folderPath, pathListForMerge)));

  await mixAudioFiles(pathListForMerge, '/home/changhan/vitraNote-room/audioSyn/evenAudio.wav');
  
  // 这里执行后续代码
}

async function addSilenceAndMerge(info: AudioInfo, LatestAudio: AudioInfo, folderPath: string, pathListForMerge: string[]) {
  const silenceDuration = ( LatestAudio.startTime.getTime() - info.startTime.getTime()) / 1000;
  const inputFile = path.join(folderPath, info.filename);
  const silenceTemp = path.join(folderPath, "silenceTemp.wav");
  if (silenceDuration > 0) {
    // 处理添加静音的逻辑
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg()
        .input('anullsrc')
        .inputOptions([`-t ${silenceDuration}`, `-ac 2`])
        .audioFrequency(44100)
        .inputFormat('lavfi')
        .format('wav')
        .save(silenceTemp)
        .on('end', function() {
          const mergedFilePath = '/home/changhan/vitraNote-room/audioCat/' + String(info.filename) + '_' + 'merged.wav';
          pathListForMerge.push(mergedFilePath);
          ffmpeg()
            .input(silenceTemp)
            .input(inputFile)
            .on('error', function(err) {
              console.log('An error occurred: ' + err.message);
              reject(err);
            })
            .on('end', function() {
              console.log('Merging finished !');
              resolve();
            })
            .mergeToFile(mergedFilePath, '/home/changhan/vitraNote-room/tempDir');
        })
        .on('error', reject);
    });
  } else {
    // 如果没有静音，直接添加路径
    pathListForMerge.push(inputFile);
  }
}

async function mixAudioFiles(pathListForMerge: string[], outputFilePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 确保输出目录存在
    const outputDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const command = ffmpeg();

    // 为每个文件添加输入
    pathListForMerge.forEach(filePath => {
      command.input(filePath);
    });

    // 使用amix滤镜来混合音频输入
    // 参数设置如下：
    // inputs: pathListForMerge.length 指定输入文件的数量
    // duration: longest 使用最长的输入文件作为混合后文件的长度
    // dropout_transition: 2 设置当输入流结束时淡出的持续时间（秒）
    command.complexFilter([
      {
        filter: 'amix',
        options: {
          inputs: pathListForMerge.length,
          duration: 'longest',
          dropout_transition: '2'
        }
      }
    ]);

    // 设置输出文件路径和格式
    command.output(outputFilePath)
      .audioCodec('libmp3lame') // 选择音频编码器，这里使用mp3
      .on('error', (err) => {
        console.error(`Error: ${err.message}`);
        reject(err);
      })
      .on('end', () => {
        console.log('Audio mixing completed successfully');
        resolve();
      });

    // 执行ffmpeg命令
    command.run();
  });
}