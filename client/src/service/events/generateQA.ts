import { TrainingData } from '@/service/mongo';
import { OpenAiChatEnum } from '@/constants/model';
import { pushSplitDataBill } from '@/service/events/pushBill';
import { openaiAccountError } from '../errorCode';
import { ChatRoleEnum } from '@/constants/chat';
import { BillSourceEnum } from '@/constants/user';
import { pushDataToKb } from '@/pages/api/openapi/kb/pushData';
import { TrainingModeEnum } from '@/constants/plugin';
import { ERROR_ENUM } from '../errorCode';
import { sendInform } from '@/pages/api/user/inform/send';
import { authBalanceByUid } from '../utils/auth';
import { axiosConfig, getOpenAIApi } from '../ai/openai';
import { ChatCompletionRequestMessage } from 'openai';

const reduceQueue = () => {
  global.qaQueueLen = global.qaQueueLen > 0 ? global.qaQueueLen - 1 : 0;
};

export async function generateQA(): Promise<any> {
  if (global.qaQueueLen >= global.systemEnv.qaMaxProcess) return;
  global.qaQueueLen++;

  let trainingId = '';
  let userId = '';

  try {
    const data = await TrainingData.findOneAndUpdate(
      {
        mode: TrainingModeEnum.qa,
        lockTime: { $lte: new Date(Date.now() - 4 * 60 * 1000) }
      },
      {
        lockTime: new Date()
      }
    ).select({
      _id: 1,
      userId: 1,
      kbId: 1,
      prompt: 1,
      q: 1,
      source: 1,
      model: 1
    });

    // task preemption
    if (!data) {
      reduceQueue();
      global.qaQueueLen <= 0 && console.log(`没有需要【QA】的数据, ${global.qaQueueLen}`);
      return;
    }

    trainingId = data._id;
    userId = String(data.userId);
    const kbId = String(data.kbId);

    await authBalanceByUid(userId);

    const startTime = Date.now();

    const chatAPI = getOpenAIApi();

    // 请求 chatgpt 获取回答
    const response = await Promise.all(
      [data.q].map((text) => {
        const messages: ChatCompletionRequestMessage[] = [
          {
            role: 'system',
            content: `你是出题人.
${data.prompt || '用户会发送一段长文本'}.
从中选出 25 个问题和答案. 答案详细完整. 按格式回答: Q1:
A1:
Q2:
A2:
...`
          },
          {
            role: 'user',
            content: text
          }
        ];
        return chatAPI
          .createChatCompletion(
            {
              model: data.model,
              temperature: 0.8,
              messages,
              stream: false
            },
            {
              timeout: 480000,
              ...axiosConfig()
            }
          )
          .then((res) => {
            const answer = res.data.choices?.[0].message?.content;
            const totalTokens = res.data.usage?.total_tokens || 0;

            const result = formatSplitText(answer || ''); // 格式化后的QA对
            console.log(`split result length: `, result.length);
            // 计费
            pushSplitDataBill({
              userId: data.userId,
              totalTokens,
              model: data.model,
              appName: 'QA 拆分'
            });
            return {
              rawContent: answer,
              result
            };
          })
          .catch((err) => {
            console.log('QA拆分错误');
            console.log(err.response?.status, err.response?.statusText, err.response?.data);
            return Promise.reject(err);
          });
      })
    );

    const responseList = response.map((item) => item.result).flat();

    // 创建 向量生成 队列
    await pushDataToKb({
      kbId,
      data: responseList.map((item) => ({
        ...item,
        source: data.source
      })),
      userId,
      model: global.vectorModels[0].model,
      mode: TrainingModeEnum.index
    });

    // delete data from training
    await TrainingData.findByIdAndDelete(data._id);

    console.log('生成QA成功，time:', `${(Date.now() - startTime) / 1000}s`);

    reduceQueue();
    generateQA();
  } catch (err: any) {
    reduceQueue();
    // log
    if (err?.response) {
      console.log('openai error: 生成QA错误');
      console.log(err.response?.status, err.response?.statusText, err.response?.data);
    } else {
      console.log('生成QA错误:', err);
    }

    // message error or openai account error
    if (err?.message === 'invalid message format') {
      await TrainingData.findByIdAndRemove(trainingId);
    }

    // 账号余额不足，删除任务
    if (userId && err === ERROR_ENUM.insufficientQuota) {
      sendInform({
        type: 'system',
        title: 'QA 任务中止',
        content:
          '由于账号余额不足，索引生成任务中止，重新充值后将会继续。暂停的任务将在 7 天后被删除。',
        userId
      });
      console.log('余额不足，暂停向量生成任务');
      await TrainingData.updateMany(
        {
          userId
        },
        {
          lockTime: new Date('2999/5/5')
        }
      );
      return generateQA();
    }

    // unlock
    await TrainingData.findByIdAndUpdate(trainingId, {
      lockTime: new Date('2000/1/1')
    });

    setTimeout(() => {
      generateQA();
    }, 1000);
  }
}

/**
 * 检查文本是否按格式返回
 */
function formatSplitText(text: string) {
  const regex = /Q\d+:(\s*)(.*)(\s*)A\d+:(\s*)([\s\S]*?)(?=Q|$)/g; // 匹配Q和A的正则表达式
  const matches = text.matchAll(regex); // 获取所有匹配到的结果

  const result = []; // 存储最终的结果
  for (const match of matches) {
    const q = match[2];
    const a = match[5];
    if (q && a) {
      // 如果Q和A都存在，就将其添加到结果中
      result.push({
        q,
        a: a.trim().replace(/\n\s*/g, '\n')
      });
    }
  }

  return result;
}
