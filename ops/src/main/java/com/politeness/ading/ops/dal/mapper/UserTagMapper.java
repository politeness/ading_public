package com.politeness.ading.ops.dal.mapper;

import java.util.List;
import org.apache.ibatis.annotations.*;

/** The ops console may only add and remove account tags, not change the account itself. Locking the account row serialises tag changes for the same user. */
@Mapper
public interface UserTagMapper {
    @Select("SELECT user_id FROM users WHERE user_id = #{userId} AND is_agent = 0 FOR UPDATE")
    String lockUser(String userId);

    @Select("SELECT tag FROM user_tags WHERE user_id = #{userId} ORDER BY id")
    List<String> list(String userId);

    @Insert("""
            INSERT INTO user_tags (user_id, tag, remark)
            SELECT #{userId}, #{tag}, #{remark}
             WHERE NOT EXISTS (SELECT 1 FROM user_tags WHERE user_id = #{userId} AND tag = #{tag})
            """)
    int add(@Param("userId") String userId, @Param("tag") String tag, @Param("remark") String remark);

    @Delete("DELETE FROM user_tags WHERE user_id = #{userId} AND tag = #{tag}")
    int remove(@Param("userId") String userId, @Param("tag") String tag);
}
