import debug from "debug";
import express from "express";
import http from "http";
import { Server as SocketIO } from "socket.io";
import mongoose from "mongoose";
import fs from 'fs';

type UserToFollow = {
  socketId: string;
  username: string;
};
type OnUserFollowedPayload = {
  userToFollow: UserToFollow;
  action: "FOLLOW" | "UNFOLLOW";
};

const serverDebug = debug("server");
const ioDebug = debug("io");
const socketDebug = debug("socket");

require("dotenv").config(
  process.env.NODE_ENV !== "development"
    ? { path: ".env.production" }
    : { path: ".env.development" },
);

const app = express();
const cors = require('cors');
app.use(cors()); // 允许所有跨域请求

const port =
  process.env.PORT || (process.env.NODE_ENV !== "development" ? 80 : 3002); // default port to listen

mongoose.connect('mongodb://localhost:27017/vitraNote')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

  const Schema = mongoose.Schema;

// 定义轨迹点的Schema
const TrailPointSchema = new Schema({
    timeComponent: [Number],
    currentPoint: [Number]
}, { _id: false });

// 定义用户轨迹的Schema
const UserTrailSchema = new Schema({
    fileName: {
        type: String,
        required: true,
        trim: true // 去除用户名两边的空格
    },
    trails: [TrailPointSchema], // 用户的轨迹数组
});

// 创建模型
const UserTrails = mongoose.model('UserTrail', UserTrailSchema);

// 定义图片模型
const ImageSchema = new mongoose.Schema({
  data: String, // 存储图片数据，例如 Base64 编码
  name: String, // 图片文件名
  type: String, // 图片的 MIME 类型
  isCurrent: { type: Boolean, default: false } // 确保这一行正确添加
});
const Image = mongoose.model('Image', ImageSchema);

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Excalidraw collaboration server is up :)");
});

app.get("/images", async (req, res) => {
  try {
    const images = await Image.find(); // 获取所有图片
    res.json(images);
  } catch (error) {
    // 断言 error 为 Error 类型
    if (error instanceof Error) {
      res.status(500).send(error.message);
    } else {
      // 如果 error 不是 Error 实例，发送通用错误消息
      res.status(500).send('An unknown error occurred');
    }
  }
});

app.get('/images/current', async (req, res) => {
  try {
    const currentImage = await Image.findOne({ isCurrent: true }).select('data name type');
    if (currentImage) {
      res.json(currentImage);
    } else {
      res.status(404).send('No current image set');
    }
  } catch (error) {
    // 断言 error 为 Error 类型
    if (error instanceof Error) {
      res.status(500).send(error.message);
    } else {
      // 如果 error 不是 Error 实例，发送通用错误消息
      res.status(500).send('An unknown error occurred');
    }
  }
});



// app.delete('/images/:id', async (req, res) => {
//   try {
//     await Image.findByIdAndDelete(req.params.id);
//     res.status(200).send("Image deleted");
//   } catch (error) {
//     // 断言 error 为 Error 类型
//     if (error instanceof Error) {
//       res.status(500).send(error.message);
//     } else {
//       // 如果 error 不是 Error 实例，发送通用错误消息
//       res.status(500).send('An unknown error occurred');
//     }
//   }
// });

const server = http.createServer(app);

server.listen(port, () => {
  serverDebug(`listening on port: ${port}`);
});

try {
  const io = new SocketIO(server, {
    transports: ["websocket", "polling"],
    cors: {
        allowedHeaders: ["Content-Type", "Authorization"],
        origin: process.env.CORS_ORIGIN || "*",
        credentials: true,
    },
    allowEIO3: true,
    maxHttpBufferSize: 1e8, // 例如，设置最大消息大小为 100 MB
  });

  io.on("connection", (socket) => {
    ioDebug("connection established!");
    io.to(`${socket.id}`).emit("init-room");
    socket.on("join-room", async (roomID) => {
      socketDebug(`${socket.id} has joined ${roomID}`);
      await socket.join(roomID);
      const sockets = await io.in(roomID).fetchSockets();
      if (sockets.length <= 1) {
        io.to(`${socket.id}`).emit("first-in-room");
      } else {
        socketDebug(`${socket.id} new-user emitted to room ${roomID}`);
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }

      io.in(roomID).emit(
        "room-user-change",
        sockets.map((socket) => socket.id),
      );
    });

    // socket.on(
    //   "server-broadcast",
    //   (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
    //     socketDebug(`${socket.id} sends update to ${roomID}`);
    //     socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
    //   },
    // );

    // socket.on(
    //   "server-volatile-broadcast",
    //   (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
    //     socketDebug(`${socket.id} sends volatile update to ${roomID}`);
    //     socket.volatile.broadcast
    //       .to(roomID)
    //       .emit("client-broadcast", encryptedData, iv);
    //   },
    // );
    // 新增的图片上传事件监听器
    // socket.on("image-upload", (roomID, image) => {
    //   socketDebug(`${socket.id} sends an image to ${roomID}`);
    //   // 广播图片数据到同一房间的其他用户
    //   socket.broadcast.to(roomID).emit("new-image", image);
    // });
    socket.on('upload', async (imageData, imageName, imageType) => {
      // 创建一个新的图片实例
      const newImage = new Image({ 
        data: imageData,
        name: imageName,
        type: imageType,
        isCurrent: false });
      // 保存到数据库
      await newImage.save();
    
      // 将图片广播给所有用户
      io.emit('new_image', imageData);
    });

    socket.on('delete_image', async (imageId) => {
      try {
        // 在数据库中查找要删除的图片
        const deletedImage = await Image.findByIdAndDelete(imageId);
    
        if (!deletedImage) {
          // 如果未找到图片，则发送错误消息给客户端
          socket.emit('error_message', 'Image not found.');
          return;
        }
    
        // 将删除成功的消息广播给所有用户
        io.emit('image_deleted', imageId);
      } catch (error) {
        // 如果发生错误，发送错误消息给客户端
        socket.emit('error_message', 'Error deleting image.');
      }
    });

    socket.on(
      "server-broadcast",
      (roomID: string, jsonData: string) => {
        socketDebug(`${socket.id} sends update to ${roomID}`);
        // Broadcast the JSON data to other clients in the room
        socket.broadcast.to(roomID).emit("client-broadcast", jsonData);
      },
    );
    
    socket.on(
      "server-volatile-broadcast",
      (roomID: string, jsonData: string) => {
        socketDebug(`${socket.id} sends volatile update to ${roomID}`);
        // Volatile broadcast of the JSON data to other clients in the room
        socket.volatile.broadcast
          .to(roomID)
          .emit("client-broadcast", jsonData);
      },
    );
    
    // 监听 'set_current_image' 事件
    socket.on('set_current_image', async (imageId) => {
      try {
        // 清除所有图片的当前状态
        await Image.updateMany({}, { $unset: { isCurrent: false } });
        // 将指定的图片设置为当前图片
        const updatedImage = await Image.findByIdAndUpdate(imageId, { isCurrent: true }, { new: true });
        // 广播当前图片已更新的事件给所有客户端
        io.emit('current_image_updated', updatedImage);
      } catch (error) {
        console.error('Error setting current image:', error);
      }
    });

    socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
      const roomID = `follow@${payload.userToFollow.socketId}`;

      switch (payload.action) {
        case "FOLLOW": {
          await socket.join(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
        case "UNFOLLOW": {
          await socket.leave(roomID);

          const sockets = await io.in(roomID).fetchSockets();
          const followedBy = sockets.map((socket) => socket.id);

          io.to(payload.userToFollow.socketId).emit(
            "user-follow-room-change",
            followedBy,
          );

          break;
        }
      }
    });

    socket.on('trailData', (data) => {
      let { fileName, timeComponent, currentPoint } = data;
      // console.log(data);
      // console.log(fileName);
      // 去除用户名中的空格
      fileName = fileName.replace(/\s+/g, '');
      // console.log(fileName)
      // console.log(currentPoint)
      // 构造要保存的数据
      const trailData = { timeComponent, currentPoint };
      // console.log(trailData);
      // MongoDB的逻辑来创建或更新记录
      // 假设您有一个叫做 UserTrails 的模型和集合
      UserTrails.findOneAndUpdate(
        { fileName: fileName }, 
        { $push: { trails: trailData } },
        { upsert: true, new: true }
    )
    .then((updatedDocument) => {
        // 可以在这里处理更新后的文档，如果需要的话
        // console.log('Trail updated successfully:', updatedDocument);
    }).catch((error) => {
        // 错误处理
        // console.error('Error updating trail:', error);
    });
    });
  
  

    socket.on("disconnecting", async () => {
      socketDebug(`${socket.id} has disconnected`);
      for (const roomID of Array.from(socket.rooms)) {
        const otherClients = (await io.in(roomID).fetchSockets()).filter(
          (_socket) => _socket.id !== socket.id,
        );

        const isFollowRoom = roomID.startsWith("follow@");

        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomID).emit(
            "room-user-change",
            otherClients.map((socket) => socket.id),
          );
        }

        if (isFollowRoom && otherClients.length === 0) {
          const socketId = roomID.replace("follow@", "");
          io.to(socketId).emit("broadcast-unfollow");
        }
      }
    });

    socket.on("disconnect", () => {
      socket.removeAllListeners();
      socket.disconnect();
    });
  });
} catch (error) {
  console.error(error);
}
