#include <node_api.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <exception>
#include <limits>
#include <new>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::size_t kDefaultMaxFrameBytes = 16U * 1024U * 1024U;
constexpr std::size_t kMaxBatchBytes = 256U * 1024U * 1024U;
constexpr std::uint32_t kMaxFramesPerBatch = 16'384U;

napi_value ThrowLastError(napi_env env, const char* operation) {
  const napi_extended_error_info* error_info = nullptr;
  napi_get_last_error_info(env, &error_info);
  const char* detail =
      error_info != nullptr && error_info->error_message != nullptr
          ? error_info->error_message
          : "unknown Node-API error";
  const std::string message = std::string(operation) + ": " + detail;
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

#define NAPI_OR_RETURN_NULL(env, operation)        \
  do {                                              \
    if ((operation) != napi_ok) {                  \
      return ThrowLastError((env), #operation);    \
    }                                               \
  } while (false)

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowRangeError(napi_env env, const char* message) {
  napi_throw_range_error(env, nullptr, message);
  return nullptr;
}

bool ReadBuffer(napi_env env, napi_value value, const std::uint8_t** data,
                std::size_t* length) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) {
    napi_throw_type_error(env, nullptr, "Every frame must be a Node.js Buffer.");
    return false;
  }

  void* raw_data = nullptr;
  if (napi_get_buffer_info(env, value, &raw_data, length) != napi_ok) {
    ThrowLastError(env, "napi_get_buffer_info");
    return false;
  }
  *data = static_cast<const std::uint8_t*>(raw_data);
  return true;
}

bool ReadMaxFrameBytes(napi_env env, napi_value value,
                       std::uint32_t* max_frame_bytes) {
  napi_valuetype value_type;
  if (napi_typeof(env, value, &value_type) != napi_ok) {
    ThrowLastError(env, "napi_typeof");
    return false;
  }
  if (value_type != napi_number) {
    ThrowTypeError(env, "maxFrameBytes must be a number.");
    return false;
  }

  double numeric_value = 0.0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    ThrowLastError(env, "napi_get_value_double");
    return false;
  }
  if (!std::isfinite(numeric_value) || numeric_value < 0.0 ||
      numeric_value >
          static_cast<double>(std::numeric_limits<std::uint32_t>::max()) ||
      std::trunc(numeric_value) != numeric_value) {
    ThrowRangeError(env,
                    "maxFrameBytes must be an integer between 0 and 2^32-1.");
    return false;
  }

  *max_frame_bytes = static_cast<std::uint32_t>(numeric_value);
  return true;
}

void WriteBigEndian32(std::uint8_t* target, std::uint32_t value) {
  target[0] = static_cast<std::uint8_t>((value >> 24U) & 0xffU);
  target[1] = static_cast<std::uint8_t>((value >> 16U) & 0xffU);
  target[2] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
  target[3] = static_cast<std::uint8_t>(value & 0xffU);
}

std::uint32_t ReadBigEndian32(const std::uint8_t* source) {
  return (static_cast<std::uint32_t>(source[0]) << 24U) |
         (static_cast<std::uint32_t>(source[1]) << 16U) |
         (static_cast<std::uint32_t>(source[2]) << 8U) |
         static_cast<std::uint32_t>(source[3]);
}

napi_value EncodeFrames(napi_env env, napi_callback_info info) {
  try {
    std::size_t argc = 1U;
    napi_value args[1];
    NAPI_OR_RETURN_NULL(
        env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 1U) {
      return ThrowTypeError(env,
                            "encodeFrames expects one array of Buffer values.");
    }

    bool is_array = false;
    NAPI_OR_RETURN_NULL(env, napi_is_array(env, args[0], &is_array));
    if (!is_array) {
      return ThrowTypeError(env, "encodeFrames expects an array.");
    }

    std::uint32_t frame_count = 0U;
    NAPI_OR_RETURN_NULL(env,
                        napi_get_array_length(env, args[0], &frame_count));
    if (frame_count > kMaxFramesPerBatch) {
      return ThrowRangeError(env, "The batch contains too many frames.");
    }

    // Copy each borrowed Buffer immediately. A later napi_get_element can run
    // an accessor which detaches or releases a Buffer returned by an earlier
    // accessor, so no borrowed pointer may survive that boundary.
    std::vector<std::uint8_t> encoded;
    for (std::uint32_t index = 0U; index < frame_count; ++index) {
      napi_value frame;
      NAPI_OR_RETURN_NULL(env, napi_get_element(env, args[0], index, &frame));

      const std::uint8_t* frame_data = nullptr;
      std::size_t frame_length = 0U;
      if (!ReadBuffer(env, frame, &frame_data, &frame_length)) {
        return nullptr;
      }
      if (frame_length > kDefaultMaxFrameBytes) {
        frame_data = nullptr;
        return ThrowRangeError(env,
                               "A frame exceeds the 16 MiB encoding limit.");
      }
      if (frame_length > kMaxBatchBytes - 4U ||
          encoded.size() > kMaxBatchBytes - 4U - frame_length) {
        frame_data = nullptr;
        return ThrowRangeError(env,
                               "The encoded batch exceeds the 256 MiB limit.");
      }

      const std::size_t frame_offset = encoded.size();
      encoded.resize(frame_offset + 4U + frame_length);
      WriteBigEndian32(encoded.data() + frame_offset,
                       static_cast<std::uint32_t>(frame_length));
      if (frame_length > 0U) {
        std::memcpy(encoded.data() + frame_offset + 4U, frame_data,
                    frame_length);
      }
      frame_data = nullptr;
    }

    static constexpr std::uint8_t kEmptyBatchData = 0U;
    const void* encoded_data = encoded.empty()
                                   ? static_cast<const void*>(&kEmptyBatchData)
                                   : static_cast<const void*>(encoded.data());
    napi_value output;
    void* copied_data = nullptr;
    NAPI_OR_RETURN_NULL(
        env, napi_create_buffer_copy(env, encoded.size(), encoded_data,
                                     &copied_data, &output));
    return output;
  } catch (const std::bad_alloc&) {
    return ThrowRangeError(env, "Insufficient memory to encode the frame batch.");
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value DecodeAvailable(napi_env env, napi_callback_info info) {
  try {
    std::size_t argc = 2U;
    napi_value args[2];
    NAPI_OR_RETURN_NULL(
        env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc < 1U) {
      return ThrowTypeError(env, "decodeAvailable expects a Buffer.");
    }

    std::uint32_t max_frame_bytes =
        static_cast<std::uint32_t>(kDefaultMaxFrameBytes);
    if (argc >= 2U &&
        !ReadMaxFrameBytes(env, args[1], &max_frame_bytes)) {
      return nullptr;
    }

    const std::uint8_t* input = nullptr;
    std::size_t input_bytes = 0U;
    if (!ReadBuffer(env, args[0], &input, &input_bytes)) {
      return nullptr;
    }
    if (input_bytes > kMaxBatchBytes + 3U) {
      input = nullptr;
      return ThrowRangeError(env,
                             "The decoded batch exceeds the 256 MiB limit.");
    }

    struct FrameSlice {
      std::size_t payload_offset;
      std::size_t payload_bytes;
    };

    std::vector<FrameSlice> slices;
    std::size_t offset = 0U;
    std::vector<std::vector<std::uint8_t>> owned_frames;

    // Validate the complete batch before allocating any JavaScript objects.
    // All work from napi_get_buffer_info through the C++ copies below is
    // non-reentrant, and every error path discards the borrowed pointer before
    // calling Node-API to construct an exception.
    try {
      while (input_bytes - offset >= 4U) {
        const std::uint32_t frame_bytes = ReadBigEndian32(input + offset);
        if (frame_bytes > max_frame_bytes) {
          input = nullptr;
          return ThrowRangeError(env, "Frame length exceeds maxFrameBytes.");
        }
        if (frame_bytes > kMaxBatchBytes - 4U ||
            offset > kMaxBatchBytes - 4U - frame_bytes) {
          input = nullptr;
          return ThrowRangeError(
              env, "The decoded batch exceeds the 256 MiB limit.");
        }
        if (slices.size() >= kMaxFramesPerBatch) {
          input = nullptr;
          return ThrowRangeError(
              env, "The decoded batch contains too many frames.");
        }
        if (input_bytes - offset - 4U < frame_bytes) {
          break;
        }
        slices.push_back({offset + 4U, frame_bytes});
        offset += 4U + frame_bytes;
      }

      owned_frames.reserve(slices.size());
      for (const FrameSlice& slice : slices) {
        std::vector<std::uint8_t> frame(slice.payload_bytes);
        if (slice.payload_bytes > 0U) {
          std::memcpy(frame.data(), input + slice.payload_offset,
                      slice.payload_bytes);
        }
        owned_frames.push_back(std::move(frame));
      }
    } catch (...) {
      input = nullptr;
      throw;
    }
    input = nullptr;

    napi_value frame_array;
    NAPI_OR_RETURN_NULL(
        env,
        napi_create_array_with_length(env, owned_frames.size(), &frame_array));
    static constexpr std::uint8_t kEmptyFrameData = 0U;
    for (std::size_t index = 0U; index < owned_frames.size(); ++index) {
      const std::vector<std::uint8_t>& owned_frame = owned_frames[index];
      const void* frame_data = owned_frame.empty()
                                   ? static_cast<const void*>(&kEmptyFrameData)
                                   : static_cast<const void*>(owned_frame.data());
      napi_value frame;
      void* copied_data = nullptr;
      NAPI_OR_RETURN_NULL(
          env, napi_create_buffer_copy(env, owned_frame.size(), frame_data,
                                       &copied_data, &frame));
      NAPI_OR_RETURN_NULL(
          env, napi_set_element(env, frame_array,
                                static_cast<std::uint32_t>(index), frame));
    }

    napi_value consumed;
    NAPI_OR_RETURN_NULL(
        env, napi_create_double(env, static_cast<double>(offset), &consumed));

    napi_value result;
    NAPI_OR_RETURN_NULL(env, napi_create_object(env, &result));
    NAPI_OR_RETURN_NULL(
        env, napi_set_named_property(env, result, "frames", frame_array));
    NAPI_OR_RETURN_NULL(
        env, napi_set_named_property(env, result, "consumed", consumed));
    return result;
  } catch (const std::bad_alloc&) {
    return ThrowRangeError(env, "Insufficient memory to decode the frame batch.");
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"encodeFrames", nullptr, EncodeFrames, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"decodeAvailable", nullptr, DecodeAvailable, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  NAPI_OR_RETURN_NULL(
      env, napi_define_properties(env, exports,
                                  sizeof(properties) / sizeof(properties[0]),
                                  properties));

  struct ExportedLimit {
    const char* name;
    std::uint32_t value;
  };
  const ExportedLimit limits[] = {
      {"defaultMaxFrameBytes",
       static_cast<std::uint32_t>(kDefaultMaxFrameBytes)},
      {"maxBatchBytes", static_cast<std::uint32_t>(kMaxBatchBytes)},
      {"maxFramesPerBatch", kMaxFramesPerBatch},
  };
  for (const ExportedLimit& limit : limits) {
    napi_value value;
    NAPI_OR_RETURN_NULL(env, napi_create_uint32(env, limit.value, &value));
    NAPI_OR_RETURN_NULL(
        env, napi_set_named_property(env, exports, limit.name, value));
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
