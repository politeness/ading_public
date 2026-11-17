package com.politeness.ading.conductor.dal.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserTagMapper {

    @Select("SELECT COUNT(*) > 0 FROM user_tags WHERE user_id = #{userId} AND tag = #{tag}")
    boolean hasTag(@Param("userId") String userId, @Param("tag") String tag);
}
